type Client = { id: number | string; name: string };

// Keep the underlying name unchanged, including in reports and CSV. Only
// ambiguous labels need a stable identifier that is consistent across views.
export function clientLabels(clients: readonly Client[]): Map<string, string> {
  const key = (name: string) => name.trim().normalize('NFC').toLocaleLowerCase('pl');
  const counts = new Map<string, number>();
  for (const client of clients) counts.set(key(client.name), (counts.get(key(client.name)) ?? 0) + 1);
  const labels = new Map(clients.map(client => [String(client.id),
    counts.get(key(client.name))! > 1 ? `ID ${client.id} · ${client.name}` : client.name]));
  const rendered = [...labels.values()].map(key);
  // An existing name may itself look like one of the generated labels.
  // In that case prefix every item to keep the choices distinguishable.
  return new Set(rendered).size === rendered.length ? labels
    : new Map(clients.map(client => [String(client.id), `ID ${client.id} · ${client.name}`]));
}
