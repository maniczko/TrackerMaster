export const defaultShortcut = 'Ctrl+Shift+Space';
export const shortcutKeys = ['Space', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)];

export function shortcutLabel(value: string): string {
  return value.replace('Ctrl+', 'Ctrl + ').replace('Shift+', 'Shift + ').replace('Alt+', 'Alt + ').replace('Space', 'Spacja');
}

export function matchesShortcut(event: Pick<KeyboardEvent, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'code' | 'repeat'>, shortcut: string): boolean {
  const parts = shortcut.split('+');
  const key = parts[2];
  const code = key?.length === 1 ? `Key${key}` : key;
  return parts.length === 3 && parts[0] === 'Ctrl' && ['Shift', 'Alt'].includes(parts[1]) && shortcutKeys.includes(key)
    && event.ctrlKey && event.shiftKey === (parts[1] === 'Shift') && event.altKey === (parts[1] === 'Alt')
    && !event.metaKey && !event.repeat && event.code === code;
}
