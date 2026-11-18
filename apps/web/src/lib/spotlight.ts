/** Pure helpers for the spotlight search (Ctrl+K). */
import type { SearchHit } from '@/api/endpoints';
import type { NavItem } from '@/modules/types';
import { formatDate, formatMoney } from './format';
import { humanize } from './labels';

/** True for the spotlight shortcut: Ctrl+K, or Cmd+K on macOS. */
export function isSpotlightShortcut(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k';
}

/**
 * Menu items matching the text, best first: label prefix, then word prefix,
 * then substring of the label or its area.
 */
export function matchMenu(items: readonly NavItem[], text: string, limit = 8): NavItem[] {
  const q = text.trim().toLowerCase();
  if (!q) return [];
  const scored: { item: NavItem; score: number }[] = [];
  for (const item of items) {
    const label = item.label.toLowerCase();
    let score = 0;
    if (label.startsWith(q)) score = 3;
    else if (label.split(/[\s/&-]+/).some((w) => w.startsWith(q))) score = 2;
    else if (label.includes(q) || item.area.toLowerCase().includes(q)) score = 1;
    if (score) scored.push({ item, score });
  }
  const seen = new Set<string>();
  return scored
    .sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label))
    .map((s) => s.item)
    .filter((i) => (seen.has(i.to) ? false : (seen.add(i.to), true)))
    .slice(0, limit);
}

export interface HitText {
  title: string;
  subtitle: string;
  /** Right-aligned amount, already formatted. */
  amount: string;
}

/** Display text for a search hit: transactions show number, party and date; lists show contact info. */
export function hitText(hit: SearchHit, category: string): HitText {
  if (category === 'txn') {
    const title = hit.refNumber ? `${humanize(hit.type)} #${hit.refNumber}` : humanize(hit.type);
    const subtitle = [
      hit.entityName ?? hit.name,
      hit.txnDate ? formatDate(hit.txnDate) : '',
      hit.memo,
    ]
      .filter(Boolean)
      .join(' · ');
    return { title, subtitle, amount: hit.amount ? formatMoney(hit.amount) : '' };
  }
  const subtitle = [
    hit.companyName && hit.companyName !== hit.name ? hit.companyName : '',
    hit.email,
    hit.phone,
    hit.isActive === false ? 'Inactive' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return { title: hit.name ?? hit.qbId, subtitle, amount: '' };
}

export interface DateRange {
  from: string;
  to: string;
}

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Common date ranges relative to `today`. */
export function datePresets(today: Date): { label: string; range: DateRange }[] {
  const y = today.getFullYear();
  const m = today.getMonth();
  const daysAgo = (n: number) => new Date(y, m, today.getDate() - n);
  const q = Math.floor(m / 3);
  return [
    { label: 'Last 30 days', range: { from: iso(daysAgo(30)), to: iso(today) } },
    {
      label: 'This month',
      range: { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) },
    },
    {
      label: 'Last month',
      range: { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) },
    },
    {
      label: 'This quarter',
      range: { from: iso(new Date(y, q * 3, 1)), to: iso(new Date(y, q * 3 + 3, 0)) },
    },
    { label: 'This year', range: { from: `${y}-01-01`, to: `${y}-12-31` } },
    { label: 'Last year', range: { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` } },
  ];
}

export interface SpotlightFilters {
  from: string | null;
  to: string | null;
  entityId: string | null;
  amountMin: string | null;
  amountMax: string | null;
  includeInactive: boolean;
}

export const emptyFilters = (): SpotlightFilters => ({
  from: null,
  to: null,
  entityId: null,
  amountMin: null,
  amountMax: null,
  includeInactive: false,
});

/** Number of active filters (for the badge on the Filters button). */
export function activeFilterCount(f: SpotlightFilters): number {
  return (
    (f.from || f.to ? 1 : 0) +
    (f.entityId ? 1 : 0) +
    (f.amountMin || f.amountMax ? 1 : 0) +
    (f.includeInactive ? 1 : 0)
  );
}

/** Whether a record search can run: text of 2+ chars or a real filter. */
export function canSearch(text: string, f: SpotlightFilters): boolean {
  return text.trim().length >= 2 || !!(f.from || f.to || f.entityId || f.amountMin || f.amountMax);
}
