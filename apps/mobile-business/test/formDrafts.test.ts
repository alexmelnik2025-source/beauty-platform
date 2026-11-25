import { describe, expect, it } from 'vitest';
import { clearDrafts, readDraft, resetDraft, writeDraft } from '../src/formDrafts';

describe('form drafts', () => {
  it('uses the latest defaults until the first edit and again after reset', () => {
    const initial = new Map();
    expect(readDraft(initial.get('price'), '50')).toBe('50');
    const edited = writeDraft(initial, 'price', '50', '0');
    expect(initial.has('price')).toBe(false);
    expect(readDraft(edited.get('price'), '65')).toBe('0');
    const reset = resetDraft(edited, 'price', edited.get('price'));
    expect(reset.has('price')).toBe(false);
    expect(readDraft(reset.get('price'), '65')).toBe('65');
    expect(readDraft(edited.get('price'), '65')).toBe('0');
  });

  it('applies consecutive functional edits to the latest stored value', () => {
    const first = writeDraft(new Map(), 'notes', ['first'], (notes) => [...notes, 'second']);
    const second = writeDraft(first, 'notes', ['different'], (notes) => [...notes, 'third']);
    expect(readDraft(second.get('notes'), [])).toEqual(['first', 'second', 'third']);
    expect(readDraft(first.get('notes'), [])).toEqual(['first', 'second']);
  });

  it.each([false, 0, '', null, undefined])('retains an explicitly entered %s', (value) => {
    const edited = writeDraft<unknown>(new Map(), 'field', 'default', value);
    expect(readDraft(edited.get('field'), 'default')).toBe(value);
  });

  it('keeps a new editor when a previous save finishes with the same value', () => {
    const submitted = writeDraft(new Map(), 'name', '', 'Cut');
    const closed = resetDraft(submitted, 'name', submitted.get('name'));
    const reopened = writeDraft(closed, 'name', '', 'Cut');
    expect(resetDraft(reopened, 'name', submitted.get('name'))).toBe(reopened);
  });

  it('clears only fields of the requested editor and leaves another salon independent', () => {
    const session = writeDraft(new Map(), 'voucher.1.amount', '', '12');
    const withNote = writeDraft(session, 'voucher.1.note', '', 'gift');
    const withOther = writeDraft(withNote, 'voucher.10.amount', '', '25');
    const otherSalon = writeDraft(new Map(), 'voucher.1.amount', '', '30');

    const cleared = clearDrafts(withOther, 'voucher.1.');
    expect([...cleared.keys()]).toEqual(['voucher.10.amount']);
    expect(withOther.size).toBe(3);
    expect(clearDrafts(cleared, 'voucher.1.')).toBe(cleared);
    expect(readDraft(otherSalon.get('voucher.1.amount'), '')).toBe('30');
  });
});
