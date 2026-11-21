// PREVIEW ONLY: ?window=widget renders the mini timer, anything else the main window.
const label = new URLSearchParams(location.search).get('window') === 'widget' ? 'widget' : 'main';
const noop = async () => {};
export function getCurrentWindow() {
  return { label, setSize: noop, setAlwaysOnTop: noop, show: noop, hide: noop, close: noop, setFocus: noop, startDragging: noop,
    onCloseRequested: async () => () => {}, listen: async () => () => {} };
}
