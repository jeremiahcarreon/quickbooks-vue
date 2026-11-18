/** Value of a `...Ref` field. */
export interface RefValue {
  ListID?: string;
  FullName?: string;
}

/** Column of a QbDataTable. */
export interface ColumnSpec {
  /** Read-model column (`name`, `txn_date`, ...) or a Ret path (`CustomerRef`, `BillAddress.City`). */
  field: string;
  header?: string;
  kind?: 'text' | 'money' | 'date' | 'bool' | 'ref';
  sortable?: boolean;
}
