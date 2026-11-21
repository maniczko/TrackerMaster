// PREVIEW ONLY: events never arrive in the browser preview.
export async function listen(_event: string, _handler: unknown): Promise<() => void> { return () => {}; }
export async function emit(): Promise<void> {}
