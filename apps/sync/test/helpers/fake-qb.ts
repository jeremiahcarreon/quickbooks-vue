import { buildResponse, getRequest, validate } from '@qbv/qbxml';

/**
 * A small in-memory QuickBooks for sync tests: answers the query shapes sync
 * sends (iterators, FromModifiedDate / ModifiedDateRangeFilter, ID lists,
 * IncludeRetElement, ListDeleted/TxnDeleted). Every request is validated
 * against the XSD; invalid ones are recorded and answered with a parse error.
 * Responses are built with @qbv/qbxml buildResponse (also XSD-validated).
 */

type Ret = Record<string, unknown>;

export interface SeenRequest {
  rq: string;
  xml: string;
  valid: boolean;
  errors: string[];
  iterator?: string;
  iteratorID?: string;
}

interface DeletedRecord {
  kind: 'list' | 'txn';
  delType: string;
  id: string;
  timeDeleted: string;
}

interface IteratorState {
  rs: string;
  items: Array<[string, Ret]>;
  pageSize: number;
}

const text = (xml: string, el: string): string[] =>
  [...xml.matchAll(new RegExp(`<${el}>([^<]*)</${el}>`, 'g'))].map((m) => unescape(m[1]!));
const attr = (xml: string, name: string): string | undefined =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(xml)?.[1];
const unescape = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

export function qbTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

export class FakeQuickBooks {
  /** Ret element name -> id -> Ret */
  readonly store = new Map<string, Map<string, Ret>>();
  readonly deleted: DeletedRecord[] = [];
  readonly requests: SeenRequest[] = [];
  private iterators = new Map<string, IteratorState>();
  private seq = 0;
  /** Rq name -> statusCode/message to answer with (e.g. feature not enabled). */
  readonly failRq = new Map<string, { code: number; message: string }>();
  /** Fail the next N iterator Continue requests (iterator expired). */
  failContinues = 0;

  idFieldFor(retName: string): 'ListID' | 'TxnID' {
    return /^(Invoice|Bill|Check|JournalEntry|Deposit|SalesReceipt|CreditMemo|Estimate)Ret$/.test(
      retName,
    )
      ? 'TxnID'
      : 'ListID';
  }

  put(retName: string, ret: Ret): Ret {
    const idField = this.idFieldFor(retName);
    const id =
      (ret[idField] as string | undefined) ??
      (ret.ListID as string | undefined) ??
      (ret.TxnID as string | undefined) ??
      'singleton';
    const m = this.store.get(retName) ?? new Map<string, Ret>();
    m.set(id, ret);
    this.store.set(retName, m);
    return ret;
  }

  remove(retName: string, id: string, kind: 'list' | 'txn', delType: string, at: Date): void {
    this.store.get(retName)?.delete(id);
    this.deleted.push({ kind, delType, id, timeDeleted: qbTime(at) });
  }

  /** Remove without a deletion record (only reconcile can notice). */
  vanish(retName: string, id: string): void {
    this.store.get(retName)?.delete(id);
  }

  handle(xml: string): string {
    const res = validate(xml);
    const msgs = xml.indexOf('<QBXMLMsgsRq');
    const afterMsgs = xml.slice(xml.indexOf('>', msgs) + 1);
    const rqMatch = /<(\w+Rq)\b[^>]*>/.exec(afterMsgs);
    const rq = rqMatch?.[1] ?? '';
    const head = rqMatch?.[0] ?? '';
    const seen: SeenRequest = {
      rq,
      xml,
      valid: res.valid,
      errors: res.errors.map((e) => `${e.line}: ${e.message}`),
      iterator: attr(head, 'iterator'),
      iteratorID: attr(head, 'iteratorID'),
    };
    this.requests.push(seen);
    const rs = rq ? getRequest(rq).response : 'UnknownRs';
    if (!res.valid) {
      return buildResponse([
        {
          rs,
          statusCode: -1,
          statusSeverity: 'Error',
          statusMessage: 'QuickBooks found an error when parsing the provided XML text stream.',
        },
      ]);
    }
    const fail = this.failRq.get(rq);
    if (fail)
      return buildResponse([
        { rs, statusCode: fail.code, statusSeverity: 'Error', statusMessage: fail.message },
      ]);

    if (rq === 'ListDeletedQueryRq' || rq === 'TxnDeletedQueryRq')
      return this.deletedQuery(rq, rs, xml);

    if (seen.iterator === 'Continue') {
      const it = this.iterators.get(seen.iteratorID ?? '');
      if (!it || this.failContinues > 0) {
        if (this.failContinues > 0) this.failContinues--;
        return buildResponse([
          {
            rs,
            statusCode: 3175,
            statusSeverity: 'Error',
            statusMessage: 'There was an error when continuing the iterator.',
          },
        ]);
      }
      return this.page(seen.iteratorID!, it);
    }

    const retElements = getRequest(rq).retElements ?? [];
    let items: Array<[string, Ret]> = [];
    for (const r of retElements)
      for (const ret of this.store.get(r)?.values() ?? []) items.push([r, ret]);

    const ids = [...text(xml, 'ListID'), ...text(xml, 'TxnID')];
    if (ids.length > 0) {
      items = items.filter(([r, ret]) => ids.includes(ret[this.idFieldFor(r)] as string));
    }
    const from = text(xml, 'FromModifiedDate')[0];
    if (from)
      items = items.filter(([, ret]) => Date.parse(ret.TimeModified as string) >= Date.parse(from));
    const include = text(xml, 'IncludeRetElement');
    if (include.length > 0) {
      items = items.map(([r, ret]) => [
        r,
        Object.fromEntries(Object.entries(ret).filter(([k]) => include.includes(k))),
      ]);
    }
    if (!/IncludeLineItems>true</.test(xml)) {
      items = items.map(([r, ret]) => [
        r,
        Object.fromEntries(Object.entries(ret).filter(([k]) => !/LineRet$/.test(k))),
      ]);
    }
    const max = Number(text(xml, 'MaxReturned')[0] ?? 0);
    if (seen.iterator === 'Start') {
      const id = `{00000000-0000-4000-8000-${String(++this.seq).padStart(12, '0')}}`;
      const it: IteratorState = { rs, items, pageSize: max || items.length || 1 };
      this.iterators.set(id, it);
      return this.page(id, it);
    }
    if (max) items = items.slice(0, max);
    if (items.length === 0) {
      return buildResponse([
        {
          rs,
          statusCode: 1,
          statusSeverity: 'Info',
          statusMessage: 'A query request did not find a matching object in QuickBooks',
        },
      ]);
    }
    return buildResponse([{ rs, body: this.body(items) }]);
  }

  private body(items: Array<[string, Ret]>): Record<string, Ret[]> {
    const body: Record<string, Ret[]> = {};
    for (const [r, ret] of items) (body[r] ??= []).push(ret);
    return body;
  }

  private page(id: string, it: IteratorState): string {
    const chunk = it.items.splice(0, it.pageSize);
    const remaining = it.items.length;
    if (remaining === 0) this.iterators.delete(id);
    if (chunk.length === 0) {
      return buildResponse([
        {
          rs: it.rs,
          statusCode: 1,
          statusSeverity: 'Info',
          statusMessage: 'No match',
          iteratorID: id,
          iteratorRemainingCount: 0,
        },
      ]);
    }
    return buildResponse([
      { rs: it.rs, body: this.body(chunk), iteratorID: id, iteratorRemainingCount: remaining },
    ]);
  }

  private deletedQuery(rq: string, rs: string, xml: string): string {
    const kind = rq === 'ListDeletedQueryRq' ? 'list' : 'txn';
    const types = text(xml, kind === 'list' ? 'ListDelType' : 'TxnDelType');
    const from = text(xml, 'FromDeletedDate')[0];
    const recs = this.deleted.filter(
      (d) =>
        d.kind === kind &&
        types.includes(d.delType) &&
        (!from || Date.parse(d.timeDeleted) >= Date.parse(from)),
    );
    if (recs.length === 0) {
      return buildResponse([
        { rs, statusCode: 1, statusSeverity: 'Info', statusMessage: 'No match' },
      ]);
    }
    const retName = kind === 'list' ? 'ListDeletedRet' : 'TxnDeletedRet';
    return buildResponse([
      {
        rs,
        body: {
          [retName]: recs.map((d) =>
            kind === 'list'
              ? {
                  ListDelType: d.delType,
                  ListID: d.id,
                  TimeCreated: d.timeDeleted,
                  TimeDeleted: d.timeDeleted,
                  FullName: d.id,
                }
              : {
                  TxnDelType: d.delType,
                  TxnID: d.id,
                  TimeCreated: d.timeDeleted,
                  TimeDeleted: d.timeDeleted,
                },
          ),
        },
      },
    ]);
  }

  invalidRequests(): SeenRequest[] {
    return this.requests.filter((r) => !r.valid);
  }
}
