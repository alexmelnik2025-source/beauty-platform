import { createElement, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { ClientApi } from '../src/api';
import { DICTIONARIES } from '../src/i18n';
import { VisitsScreen } from '../src/screens/VisitsScreen';
import { Button } from '../src/ui';

vi.mock('react-native', () => vi.importActual('react-native-web'));
vi.mock('../src/screens/VisitScreen', () => ({ VisitScreen: () => null }));
vi.mock('../src/ui', async (importOriginal) => {
  const ui = await importOriginal<typeof import('../src/ui')>();
  return { ...ui, Button: vi.fn(ui.Button) };
});

const { renderToStaticMarkup } = await vi.importActual<{
  renderToStaticMarkup(node: ReactNode): string;
}>('react-dom/server');

it('starts only one sign-out even when two presses reach the button before a re-render', async () => {
  let finish!: () => void;
  const onSignOut = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
  const t = DICTIONARIES.en;
  renderToStaticMarkup(
    createElement(VisitsScreen, {
      api: new ClientApi('', { get: vi.fn(), set: vi.fn() }),
      t,
      locale: 'en',
      person: { id: 'client', email: 'client@example.com', locale: 'en' },
      onSignOut,
      onSessionEnded: vi.fn(),
      onLocale: vi.fn(),
      onFindSalon: vi.fn(),
      onShop: vi.fn(),
      onBook: vi.fn(),
      onOpenSalon: vi.fn(),
      favoritesVersion: 0,
    }),
  );
  const signOut = vi.mocked(Button).mock.calls.find(([props]) => props.label === t.visits.signOut);
  expect(signOut).toBeDefined();
  const { onPress } = signOut![0];

  const first = onPress();
  onPress();
  expect(onSignOut).toHaveBeenCalledTimes(1);
  finish();
  await first;
});
