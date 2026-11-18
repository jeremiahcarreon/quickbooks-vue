import type { ObjectDef, QbObject } from '@/api/types';
import { humanize } from '@/lib/labels';
import { isRefObject } from '@/forms/model';
import type { ColumnSpec } from './types';

/** Read-model columns and how they map onto QbObject. */
const ROW_COLUMNS: Record<string, keyof QbObject> = {
  qb_id: 'id',
  name: 'name',
  ref_number: 'refNumber',
  txn_date: 'txnDate',
  amount: 'amount',
  is_active: 'isActive',
  time_created: 'timeCreated',
  time_modified: 'timeModified',
  edit_sequence: 'editSequence',
};

export function defaultColumns(category: 'list' | 'txn' | 'other'): ColumnSpec[] {
  if (category === 'txn') {
    return [
      { field: 'txn_date', header: 'Date', kind: 'date' },
      { field: 'ref_number', header: 'No.' },
      { field: 'name', header: 'Name' },
      { field: 'amount', header: 'Amount', kind: 'money' },
      { field: 'time_modified', header: 'Modified', kind: 'date' },
    ];
  }
  return [
    { field: 'name', header: 'Name' },
    { field: 'is_active', header: 'Active', kind: 'bool' },
    { field: 'time_modified', header: 'Modified', kind: 'date' },
  ];
}

const SKIP = new Set(['ListID', 'TxnID', 'EditSequence', 'TimeCreated', 'TimeModified']);

/** Every simple and ref field of the Ret (plus one level of nested simple fields like BillAddress.City). */
export function retColumns(
  def: ObjectDef | undefined,
  objects?: Record<string, ObjectDef>,
  prefix = '',
): ColumnSpec[] {
  if (!def) return [];
  const out: ColumnSpec[] = [];
  for (const f of def.fields) {
    if (SKIP.has(f.name) || f.maxOccurs !== 1) continue;
    const field = `${prefix}${f.name}`;
    const header = prefix
      ? `${humanize(prefix.slice(0, -1))} ${humanize(f.name)}`
      : humanize(f.name);
    if (f.kind === 'simple') {
      const kind =
        f.type === 'AMTTYPE'
          ? 'money'
          : f.type === 'DATETYPE' || f.type === 'DATETIMETYPE'
            ? 'date'
            : f.type === 'BOOLTYPE'
              ? 'bool'
              : 'text';
      out.push({ field, header, kind });
      continue;
    }
    const child = objects?.[f.children ?? f.type];
    if (f.name.endsWith('Ref') || isRefObject(child)) {
      out.push({ field, header, kind: 'ref' });
    } else if (!prefix && child) {
      out.push(...retColumns(child, objects, `${f.name}.`).filter((c) => c.kind !== 'ref'));
    }
  }
  return out;
}

/** Value of a column for a row: a read-model column or a path into the Ret data. */
export function columnValue(row: QbObject, c: ColumnSpec): unknown {
  const k = ROW_COLUMNS[c.field];
  if (k) return row[k];
  let v: unknown = row.data;
  for (const seg of c.field.split('.')) {
    if (v === null || v === undefined || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[seg];
  }
  if (c.kind === 'ref' && v && typeof v === 'object') {
    const r = v as Record<string, unknown>;
    return r.FullName ?? r.ListID;
  }
  return v;
}

/** Sort/filter key sent to the API for a column. */
export function sortKeyOf(c: ColumnSpec): string {
  return c.kind === 'ref' && !c.field.includes('.') ? `${c.field}.FullName` : c.field;
}
