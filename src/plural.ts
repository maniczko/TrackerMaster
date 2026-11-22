// Polish plural forms: 1 okres, 2–4 okresy (also 22–24, 32–34…), 0 and 5+ okresów (also 12–14).
export function pluralForm(count: number, one: string, few: string, many: string): string {
  const n = Math.abs(Math.trunc(count));
  if (n === 1) return one;
  const tens = n % 100;
  const units = n % 10;
  return units >= 2 && units <= 4 && (tens < 12 || tens > 14) ? few : many;
}

/** "1 okres", "3 okresy", "5 okresów". */
export const sleepPeriodCount = (count: number) => `${count} ${pluralForm(count, 'okres', 'okresy', 'okresów')}`;
