/**
 * XSD validation for tests running under jsdom. libxml2-wasm needs the plain
 * Node environment, so the request is built and validated by @qbv/qbxml in a
 * child Node process.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// import.meta.url is not a file: URL under jsdom; tests run from apps/web or the repo root.
const webRoot = existsSync(path.join(process.cwd(), 'apps/web/package.json'))
  ? path.join(process.cwd(), 'apps/web')
  : process.cwd();

const SCRIPT = `
import { buildRequest, validate } from '@qbv/qbxml';
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const { rq, body, xml } = JSON.parse(input);
let out;
try {
  const doc = xml ?? buildRequest(rq, body);
  const res = validate(doc);
  out = { xml: doc, valid: res.valid, errors: res.errors };
} catch (err) {
  out = { xml: err.xml ?? null, valid: false, errors: err.errors ?? [{ message: String(err.message ?? err) }] };
}
process.stdout.write(JSON.stringify(out));
`;

export interface XsdResult {
  xml: string | null;
  valid: boolean;
  errors: { line?: number; message: string }[];
}

/** Build `rq` from `body` (or take `xml` as is) and validate it against the XSD. */
export function xsdCheck(input: { rq: string; body: unknown } | { xml: string }): XsdResult {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', SCRIPT], {
    cwd: webRoot,
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 60_000,
  });
  return JSON.parse(out) as XsdResult;
}
