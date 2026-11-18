/** Resolve a local form value only when it identifies exactly one instant. */
export function parseLocalDate(value: string): Date | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!parts) return null;
  const date = new Date(value);
  const expected = parts.slice(1).map(part => Number(part || 0));
  const components = (d: Date) => [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
  if (Number.isNaN(date.getTime()) || components(date).some((part, index) => part !== expected[index])) return null;
  // During a backward clock change the same local time can identify two instants.
  for (let minutes = -180; minutes <= 180; minutes++) {
    if (minutes === 0) continue;
    const other = new Date(date.getTime() + minutes * 60_000);
    if (components(other).every((part, index) => part === expected[index])) return null;
  }
  return date;
}
