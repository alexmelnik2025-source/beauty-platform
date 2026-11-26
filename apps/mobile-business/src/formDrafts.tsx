import {
  createContext,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';

type DraftEntry = { readonly value: unknown };
type DraftsState = ReadonlyMap<string, DraftEntry>;

export function readDraft<T>(entry: DraftEntry | undefined, initial: T): T {
  return entry ? (entry.value as T) : initial;
}

/** Each write has its own identity so a late save cannot discard a reopened editor. */
export function writeDraft<T>(
  drafts: DraftsState,
  key: string,
  initial: T,
  next: T | ((previous: T) => T),
): DraftsState {
  const previous = readDraft(drafts.get(key), initial);
  const value = typeof next === 'function' ? (next as (previous: T) => T)(previous) : next;
  return new Map(drafts).set(key, { value });
}

export function resetDraft(
  drafts: DraftsState,
  key: string,
  submitted: DraftEntry | undefined,
): DraftsState {
  if (!submitted || drafts.get(key) !== submitted) return drafts;
  const remaining = new Map(drafts);
  remaining.delete(key);
  return remaining;
}

export function clearDrafts(drafts: DraftsState, prefix: string): DraftsState {
  const remaining = new Map(drafts);
  for (const key of drafts.keys()) {
    if (key.startsWith(prefix)) remaining.delete(key);
  }
  return remaining.size === drafts.size ? drafts : remaining;
}

function createDraftStore() {
  let entries: DraftsState = new Map();
  const listeners = new Set<() => void>();
  return {
    get: (key: string) => entries.get(key),
    update(change: (current: DraftsState) => DraftsState) {
      const next = change(entries);
      if (next === entries) return;
      entries = next;
      for (const notify of listeners) notify();
    },
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => {
        listeners.delete(notify);
      };
    },
  };
}

const Drafts = createContext<ReturnType<typeof createDraftStore> | null>(null);

/** Drafts live in memory for the current salon session, including across screen unmounts. */
export function FormDrafts({ children }: { children: ReactNode }) {
  const [store] = useState(createDraftStore);
  return <Drafts.Provider value={store}>{children}</Drafts.Provider>;
}

/** reset() ends this version of the draft. Edits made while a save was pending survive. */
export function useFormDraft<T>(
  key: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>, () => void] {
  const shared = useContext(Drafts);
  const [local] = useState(() => shared ?? createDraftStore());
  const store = shared ?? local;
  const snapshot = useCallback(() => store.get(key), [store, key]);
  const entry = useSyncExternalStore(store.subscribe, snapshot, snapshot);
  const set = useCallback(
    (next: SetStateAction<T>) => {
      store.update((drafts) => writeDraft(drafts, key, initial, next));
    },
    [store, key, initial],
  );
  const reset = useCallback(() => {
    store.update((drafts) => resetDraft(drafts, key, entry));
  }, [store, key, entry]);
  return [readDraft(entry, initial), set, reset];
}

/** End an editor session so the next visit starts with fresh defaults. */
export function useClearFormDraft(prefix: string) {
  const store = useContext(Drafts);
  return useCallback(() => {
    store?.update((drafts) => clearDrafts(drafts, prefix));
  }, [store, prefix]);
}
