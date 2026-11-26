import { useSyncExternalStore, type ComponentProps } from 'react';
import { TextInput } from 'react-native';
import type { Location } from '../api';
import { salonForm, type SalonForm, type LegalKey } from '../salon';

type Values = SalonForm & { email: string };
export type SalonEdits = Partial<Values>;
type TextKey =
  | 'name'
  | 'addressLine'
  | 'city'
  | 'postalCode'
  | 'phone'
  | 'email'
  | 'description'
  | 'minLeadMinutes'
  | 'bookingHorizonDays'
  | 'clientCancelDeadlineMinutes'
  | 'coordinates'
  | LegalKey;

export function settingsForm(location: Location): Values {
  return { ...salonForm(location), email: location.email ?? '' };
}

// Keep one draft across sections. Inputs subscribe to their own value, while the screen
// follows the save bar and the controls in the currently visible section.
export class SalonDraft {
  private listeners = new Set<() => void>();
  private changed = new Set<keyof Values>();

  public values: Values;
  constructor(
    private readonly saved: Values,
    edits?: SalonEdits | null,
  ) {
    this.values = { ...saved, ...edits };
    if (edits) {
      for (const key of Object.keys(edits) as (keyof Values)[]) this.track(key);
    }
  }

  get edits(): SalonEdits {
    return Object.fromEntries(Array.from(this.changed, (key) => [key, this.values[key]]));
  }

  afterSave(submitted: Values, location: Location) {
    const next = new SalonDraft(settingsForm(location));
    // The server may normalize the submitted values. Keep only edits made while saving.
    for (const key of Object.keys(submitted) as (keyof Values)[]) {
      if (this.values[key] !== submitted[key]) next.change(key, this.values[key]);
    }
    return next;
  }

  private track(key: keyof Values) {
    const value = this.values[key];
    const saved = this.saved[key];
    const same =
      Array.isArray(value) && Array.isArray(saved)
        ? value.length === saved.length && value.every((item, i) => item === saved[i])
        : value === saved;
    if (same) this.changed.delete(key);
    else this.changed.add(key);
  }

  get dirty() {
    return this.changed.size > 0;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  change<K extends keyof Values>(key: K, value: Values[K]) {
    if (this.values[key] === value) return;
    this.values = { ...this.values, [key]: value };
    this.track(key);
    this.listeners.forEach((listener) => listener());
  }
}

const noSubscription = () => () => {};

export function useSalonValue<T>(draft: SalonDraft | null, read: () => T) {
  return useSyncExternalStore(draft?.subscribe ?? noSubscription, read);
}

export function SalonDraftInput({
  draft,
  field,
  onEdited,
  ...props
}: ComponentProps<typeof TextInput> & {
  draft: SalonDraft;
  field: TextKey;
  onEdited?: () => void;
}) {
  const value = useSalonValue(draft, () => draft.values[field]);
  return (
    <TextInput
      {...props}
      value={value}
      onChangeText={(text) => {
        draft.change(field, text);
        onEdited?.();
      }}
    />
  );
}
