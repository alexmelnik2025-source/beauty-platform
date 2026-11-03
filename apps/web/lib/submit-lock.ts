import { useCallback, useRef, useState } from 'react';

/**
 * One save at a time per form (owner's test 03.11.2026, T4: a second tap on «Zapisz» while
 * the first was still saving created a duplicate service). The ref blocks a second submit
 * even before React has re-rendered the disabled button.
 */
export function useSubmitLock(): { busy: boolean; lock: () => boolean; unlock: () => void } {
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const lock = useCallback(() => {
    if (locked.current) return false;
    locked.current = true;
    setBusy(true);
    return true;
  }, []);
  const unlock = useCallback(() => {
    locked.current = false;
    setBusy(false);
  }, []);
  return { busy, lock, unlock };
}
