const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD[THH:mm[:ss]]` -> local Date (null if not a date). */
export function parseQbDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:T(\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?/.exec(s);
  if (!m) return null;
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0),
  );
}

/** Local Date -> `YYYY-MM-DD` (or `YYYY-MM-DDTHH:mm:ss`). */
export function formatQbDate(d: Date, withTime = false): string {
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return withTime
    ? `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    : date;
}

export function todayQb(): string {
  return formatQbDate(new Date());
}
