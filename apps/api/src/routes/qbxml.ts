import type { FastifyInstance } from 'fastify';
import { writeAudit } from '@qbv/db';
import { catalog, parseResponse, qbxmlVersionOf, validate } from '@qbv/qbxml';
import { enqueueCommand, Priority } from '@qbv/queue';
import { typed, type RouteContext } from '../context.js';
import { actorOf, authorize, can, clientIp, requirePrincipal } from '../lib/auth.js';
import { waitFor } from '../lib/commands.js';
import { badRequest, errorBody } from '../lib/errors.js';
import { zFlag } from '../lib/query.js';
import { rawRequestAccess } from '../lib/raw-permissions.js';
import { commandView } from '../lib/views.js';
import { z } from '../lib/zod.js';

const MSG_SETS = new Set(['QBXMLMsgsRq', 'QBXMLSubscriptionMsgsRq']);

/** Request element names in a (validated) qbXML request document, in order. */
export function requestNames(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<([A-Za-z0-9]+Rq)(?=[\s>/])/g)) {
    const n = m[1]!;
    if (!MSG_SETS.has(n)) out.push(n);
  }
  return out;
}

function wantsJson(accept: string | undefined): boolean {
  if (!accept) return false;
  const a = accept.toLowerCase();
  return a.includes('application/json') && !a.includes('xml');
}

export async function qbxmlRoutes(app: FastifyInstance, ctx: RouteContext): Promise<void> {
  const r = typed(app);
  const { deps } = ctx;

  r.post(
    '/qbxml/validate',
    {
      bodyLimit: 5 * 1024 * 1024,
      config: { permission: 'qbxml:raw' },
      schema: {
        tags: ['qbxml'],
        summary: 'Check a qbXML document against the XSD without sending it',
        description:
          'Same body as POST /qbxml. Always 200 `{valid, errors[{line, column?, message, path?}], requests, version, access}`; nothing is queued. ' +
          'Besides the XSD, a request must carry exactly one `<?qbxml version="N.N"?>` instruction with a version QuickBooks has shipped. ' +
          '`access` lists each request with the permissions POST /qbxml will require and whether the caller holds them.',
        body: z.union([z.string(), z.object({ qbxml: z.string() })]),
      },
    },
    async (req) => {
      const xml = typeof req.body === 'string' ? req.body : req.body.qbxml;
      if (!xml.trim()) {
        return {
          valid: false,
          errors: [{ line: 0, message: 'Empty qbXML document' }],
          requests: [],
        };
      }
      const result = validate(xml);
      const access = result.valid
        ? rawRequestAccess(xml).map((a) => ({
            ...a,
            allowed: a.permissions.every((p) => can(req, p)),
          }))
        : [];
      return {
        valid: result.valid,
        errors: result.errors,
        requests: result.valid ? requestNames(xml) : [],
        version: qbxmlVersionOf(xml) ?? null,
        access,
      };
    },
  );

  r.post(
    '/qbxml',
    {
      bodyLimit: 5 * 1024 * 1024,
      config: { permission: 'qbxml:raw', rateLimit: 'qbxml' },
      schema: {
        tags: ['qbxml'],
        summary: 'Send raw qbXML to QuickBooks (XSD-validated; 400 with libxml2 errors if invalid)',
        description:
          'Body: the qbXML document as `application/xml` / `text/xml`, or JSON `{"qbxml": "..."}`. ' +
          'Besides qbxml:raw, every request in the document needs the matching permission: object:<Type>:read for queries, ' +
          'object:<Type>:write for Add/Mod/Del/Void/Merge, report:* for report queries, and admin for UI display, ' +
          'QBCommandExec and subscription requests (403 otherwise; nothing is queued). ' +
          'Runs through the relay queue at priority 2 and waits for QuickBooks (up to COMMAND_WAIT_TIMEOUT; `?wait=false` returns 202 at once). ' +
          'Returns QuickBooks’ response XML, or JSON `{commandId, responseXml, responses}` with `Accept: application/json`. ' +
          'Writes also update the read model.',
        querystring: z.object({ wait: zFlag }),
        body: z.union([z.string(), z.object({ qbxml: z.string() })]),
      },
    },
    async (req, reply) => {
      const p = requirePrincipal(req);
      const xml = typeof req.body === 'string' ? req.body : req.body.qbxml;
      if (!xml.trim()) throw badRequest('qbxml_invalid', 'Empty qbXML document');

      const result = validate(xml);
      if (!result.valid) {
        throw badRequest('qbxml_invalid', 'qbXML failed XSD validation', {
          errors: result.errors,
        });
      }
      const names = requestNames(xml);
      if (!/<QBXML(Subscription)?MsgsRq[\s>]/.test(xml) || names.length === 0) {
        throw badRequest(
          'qbxml_not_request',
          'The document is valid qbXML but contains no requests (QBXMLMsgsRq)',
        );
      }
      // qbxml:raw only opens the endpoint; each request still needs the
      // object/report permission the REST routes would require.
      for (const a of rawRequestAccess(xml)) for (const perm of a.permissions) authorize(req, perm);
      const defs = names.map((n) => catalog.requests[n]);
      const writes = defs.some((d) => !d || d.op !== 'Query');
      const entities = [...new Set(defs.map((d) => d?.entity).filter(Boolean))];

      const { command } = await enqueueCommand(
        deps.db,
        deps.queue,
        {
          kind: 'raw',
          rqName: names.length === 1 ? names[0]! : null,
          objectType: entities.length === 1 ? entities[0]! : null,
          payload: { requests: names },
          requestXml: xml,
          priority: Priority.InteractiveRead,
          ...actorOf(p),
        },
        { events: deps.events },
      );
      await writeAudit(deps.db, {
        ...actorOf(p),
        action: 'qbxml.raw',
        objectType: entities.length === 1 ? entities[0]! : null,
        commandId: command.id,
        ip: clientIp(req),
        detail: { requests: names, writes },
      });
      reply.header('x-command-id', command.id);

      if (req.query.wait === false) {
        return reply.code(202).send({ commandId: command.id, status: command.status });
      }
      const res = await waitFor(deps, reply, command.id);
      const c = res.command ?? command;
      if (!res.done) {
        return reply.code(202).send({ commandId: c.id, status: c.status });
      }
      if (!c.response_xml) {
        const code = c.status === 'rejected' ? 400 : 502;
        return reply
          .code(code)
          .send(
            errorBody(
              c.status === 'rejected' ? 'qbxml_rejected' : 'relay_error',
              c.status_message ?? `Command ${c.status} without a QuickBooks response`,
              { commandId: c.id, command: commandView(c) },
            ),
          );
      }
      if (wantsJson(req.headers.accept)) {
        let responses: unknown = null;
        let parseError: string | null = null;
        try {
          responses = parseResponse(c.response_xml);
        } catch (err) {
          parseError = (err as Error).message;
        }
        return reply.code(200).send({
          commandId: c.id,
          status: c.status,
          statusCode: c.status_code,
          statusMessage: c.status_message,
          responseXml: c.response_xml,
          responses,
          ...(parseError ? { parseError } : {}),
        });
      }
      return reply.code(200).type('application/xml; charset=utf-8').send(c.response_xml);
    },
  );
}
