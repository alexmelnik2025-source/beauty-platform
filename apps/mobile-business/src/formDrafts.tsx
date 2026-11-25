import {
  createContext,
  useCallback,
  useContext,
  useReducer,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';

const Drafts = createContext<Map<string, unknown> | null>(null);

/** Drafts live in memory for the current salon session, including across screen unmounts. */
export function FormDrafts({ children }: { children: ReactNode }) {
  const [drafts] = useState(() => new Map<string, unknown>());
  return <Drafts.Provider value={drafts}>{children}</Drafts.Provider>;
}

export function useFormDraft<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const shared = useContext(Drafts);
  const [local] = useState(() => new Map<string, unknown>());
  const drafts = shared ?? local;
  const [, refresh] = useReducer((revision: number) => revision + 1, 0);
  const read = () => (drafts.has(key) ? (drafts.get(key) as T) : initial);
  return [
    read(),
    useCallback(
      (next: SetStateAction<T>) => {
        const previous = drafts.has(key) ? (drafts.get(key) as T) : initial;
        drafts.set(key, typeof next === 'function' ? (next as (value: T) => T)(previous) : next);
        refresh();
      },
      [drafts, key, initial],
    ),
  ];
}

/** End an editor session so the next visit starts with fresh defaults. */
export function useClearFormDraft(prefix: string) {
  const drafts = useContext(Drafts);
  return () => {
    if (!drafts) return;
    for (const key of drafts.keys()) {
      if (key.startsWith(prefix)) drafts.delete(key);
    }
  };
}
