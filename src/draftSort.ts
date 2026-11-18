export type DraftSort = 'newest' | 'oldest';
export type DraftSortState = { order: DraftSort; writing: boolean; failed: boolean };

const autoRetryInterval = 10 * 60 * 1000;

export function createDraftSort(
  persist: (order: DraftSort) => Promise<void>,
  publish: (state: DraftSortState) => void,
  now = () => performance.now(),
) {
  let state: DraftSortState = { order: 'newest', writing: false, failed: false };
  let generation = 0;
  let lastAutoRetry: number | null = null;
  let write: Promise<void> | null = null;

  function update(changes: Partial<DraftSortState>) {
    state = { ...state, ...changes };
    publish(state);
  }

  function startWrite(): Promise<void> {
    const requested = state.order;
    const version = generation;
    update({ writing: true });
    write = Promise.resolve()
      .then(() => persist(requested))
      .then(
        () => { if (version === generation) update({ failed: false }); },
        () => { if (version === generation) update({ failed: true }); },
      ).then(() => {
        write = null;
        if (version !== generation) return startWrite();
        update({ writing: false });
      });
    return write;
  }

  return {
    restore(order: DraftSort) {
      if (generation === 0) update({ order });
    },
    choose(order: DraftSort) {
      if (order === state.order) return write ?? Promise.resolve();
      generation++;
      update({ order });
      return write ?? startWrite();
    },
    enterList() {
      if (write || !state.failed) return Promise.resolve();
      const time = now();
      if (lastAutoRetry !== null && time - lastAutoRetry < autoRetryInterval) return Promise.resolve();
      lastAutoRetry = time;
      return startWrite();
    },
    retry() {
      if (write || !state.failed) return Promise.resolve();
      return startWrite();
    },
  };
}
