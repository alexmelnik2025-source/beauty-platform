import { createElement, type ReactNode } from 'react';
import type { PressableProps } from 'react-native';
import { expect, it, vi } from 'vitest';
import { DICTIONARIES } from '../src/i18n';
import { WishesPicker } from '../src/WishesPicker';
import { DRINK_ICON, MOOD_ICON } from '../src/wishes';

type WishButtonProps = PressableProps & { 'aria-pressed'?: boolean };
const buttons: WishButtonProps[] = [];
vi.mock('react-native', async () => ({
  ...(await vi.importActual('react-native-web')),
  Pressable(props: WishButtonProps) {
    buttons.push(props);
    return null;
  },
}));

const { renderToStaticMarkup } = await vi.importActual<{
  renderToStaticMarkup(node: ReactNode): string;
}>('react-dom/server');

it('exposes the selected mood and drink to native screen readers as well as the web', () => {
  const t = DICTIONARIES.en;
  const w = t.wishStep;
  buttons.length = 0;
  renderToStaticMarkup(
    createElement(WishesPicker, {
      t,
      questions: { mood: true, drinks: ['tea'], note: false },
      value: { mood: 'quiet', drink: 'tea', note: null },
      onChange: () => {},
    }),
  );
  expect(buttons).toHaveLength(5);
  expect(
    buttons.filter((b) => b.accessibilityState?.selected).map((b) => b.accessibilityLabel),
  ).toEqual([MOOD_ICON.quiet + ' ' + w.mood.quiet, DRINK_ICON.tea + ' ' + w.drink.tea]);
  for (const props of buttons) {
    expect(props.accessibilityRole).toBe('button');
    expect(props.accessibilityLabel).toBeTruthy();
    expect(typeof props.accessibilityState?.selected).toBe('boolean');
    expect(props['aria-pressed']).toBe(props.accessibilityState?.selected);
  }
});
