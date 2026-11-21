/** Turns an error or backend message into one sentence: adds a final period only when it does not end one already. */
export function sentence(text: unknown): string {
  const value = String(text).trim();
  if (!value) return '';
  return /[.!?…]$/.test(value) ? value : `${value}.`;
}
