import {
  buildRequest,
  getObject,
  isOk,
  parseResponse,
  type EntityDef,
  type ParsedRs,
} from '@qbv/qbxml';
import type { Ret } from '@qbv/db';
import type { RelayLike } from './types.js';

/** Thrown when QuickBooks answers a follow-up query with an error status. */
export class LookupError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'LookupError';
    this.statusCode = statusCode;
  }
}

/** Status codes QuickBooks uses for "nothing matched" on a query. */
const NOT_FOUND_CODES = new Set([1, 500]);

/**
 * Small follow-up queries the worker sends on its own (conflict refresh,
 * refresh after a void, checking whether an interrupted write was applied).
 * Every request is built with @qbv/qbxml buildRequest, which validates it
 * against the XSD, and the relay client validates it again before sending.
 */
export class QbLookup {
  constructor(
    private readonly relay: RelayLike,
    private readonly version?: string,
  ) {}

  /** The query request used to read one entity (its own query, or the union query). */
  queryRqOf(entity: EntityDef): string | undefined {
    return entity.ops.query ?? entity.unionQuery;
  }

  private queryFields(rq: string): Set<string> {
    try {
      return new Set(getObject(rq).fields.map((f) => f.name));
    } catch {
      return new Set();
    }
  }

  /** Build (and so XSD-validate) a query document for an entity. */
  buildQuery(entity: EntityDef, filter: Record<string, unknown>): string {
    const rq = this.queryRqOf(entity);
    if (!rq) throw new LookupError(`${entity.name} has no query request`, -1);
    const fields = this.queryFields(rq);
    const body: Record<string, unknown> = { ...filter };
    // Transactions: ask for lines and links so the stored object is complete.
    if (fields.has('IncludeLineItems')) body.IncludeLineItems = true;
    if (fields.has('IncludeLinkedTxns')) body.IncludeLinkedTxns = true;
    return buildRequest(rq, body, { requestID: 'lookup', version: this.version });
  }

  async send(xml: string): Promise<ParsedRs> {
    const response = await this.relay.request(xml);
    const rs = parseResponse(response)[0];
    if (!rs) throw new LookupError('QuickBooks returned no response element', -1);
    return rs;
  }

  /** Rets of this entity's kind from a query response (union queries return several kinds). */
  private retsOf(entity: EntityDef, rs: ParsedRs): Ret[] {
    return rs.rets.filter((_, i) => rs.retNames[i] === entity.retElement);
  }

  private async run(entity: EntityDef, filter: Record<string, unknown>): Promise<Ret[]> {
    const rs = await this.send(this.buildQuery(entity, filter));
    if (rs.rets.length === 0 && NOT_FOUND_CODES.has(rs.statusCode)) return [];
    if (!isOk(rs)) {
      throw new LookupError(
        `${rs.name} failed: ${rs.statusCode} ${rs.statusMessage}`.trim(),
        rs.statusCode,
      );
    }
    return this.retsOf(entity, rs);
  }

  /** Can this entity be read back by ListID/TxnID? */
  canQueryById(entity: EntityDef): boolean {
    const rq = this.queryRqOf(entity);
    return !!rq && !!entity.idField && this.queryFields(rq).has(entity.idField);
  }

  /** Current object by ListID/TxnID, or null when QuickBooks has no such object. */
  async byId(entity: EntityDef, id: string): Promise<Ret | null> {
    if (!entity.idField || !this.canQueryById(entity)) {
      throw new LookupError(`${entity.name} cannot be queried by id`, -1);
    }
    const rets = await this.run(entity, { [entity.idField]: [id] });
    return rets.find((r) => r[entity.idField!] === id) ?? rets[0] ?? null;
  }

  canQueryByFullName(entity: EntityDef): boolean {
    const rq = this.queryRqOf(entity);
    return !!rq && this.queryFields(rq).has('FullName');
  }

  async byFullName(entity: EntityDef, fullName: string): Promise<Ret[]> {
    return this.run(entity, { FullName: [fullName] });
  }

  canQueryByRefNumber(entity: EntityDef): boolean {
    const rq = this.queryRqOf(entity);
    return !!rq && this.queryFields(rq).has('RefNumber');
  }

  async byRefNumber(entity: EntityDef, refNumber: string): Promise<Ret[]> {
    return this.run(entity, { RefNumber: [refNumber] });
  }
}
