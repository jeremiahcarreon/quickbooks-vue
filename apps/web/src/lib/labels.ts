/** Human labels for qbXML element and entity names. */

const WORDS: Record<string, string> = {
  AR: 'A/R',
  AP: 'A/P',
  ID: 'ID',
  TxnID: 'Transaction ID',
  ListID: 'List ID',
  Desc: 'Description',
  Txn: 'Transaction',
  Addr: 'Address',
  Amt: 'Amount',
  UOM: 'Unit of Measure',
};

/** `ARAccountRef` -> `A/R Account`, `ItemNonInventory` -> `Item Non Inventory`, `Addr1` -> `Address 1`. */
export function humanize(name: string): string {
  if (WORDS[name]) return WORDS[name];
  const base = name.length > 3 && name.endsWith('Ref') ? name.slice(0, -3) : name;
  const parts = base
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .split(' ')
    .filter(Boolean)
    .map((w) => WORDS[w] ?? w);
  return parts.join(' ');
}

/** Plural-ish title for an entity list screen. */
export function entityTitle(name: string): string {
  const h = humanize(name);
  if (/(s|x|ch|sh)$/.test(h)) return `${h}es`;
  if (/[^aeiou]y$/.test(h)) return `${h.slice(0, -1)}ies`;
  return `${h}s`;
}
