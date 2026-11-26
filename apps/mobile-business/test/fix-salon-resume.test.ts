import { createElement, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { BusinessApi } from '../src/api';
import { DICTIONARIES } from '../src/i18n';
import { NewSalonScreen } from '../src/screens/NewSalonScreen';

vi.mock('react-native', () => vi.importActual('react-native-web'));
vi.mock('../src/screens/SalonScreen', () => ({ ChoiceList: () => null }));

const { renderToStaticMarkup } = await vi.importActual<{
  renderToStaticMarkup(node: ReactNode): string;
}>('react-dom/server');

it.each([
  { organization: null, expectedName: '', locked: false },
  { organization: { id: 'org', name: 'Łódź' }, expectedName: 'Łódź', locked: true },
])('only locks the organization name already saved on the server ($expectedName)', (example) => {
  const markup = renderToStaticMarkup(
    createElement(NewSalonScreen, {
      api: new BusinessApi('', { get: vi.fn(), set: vi.fn() }),
      t: DICTIONARIES.pl,
      locale: 'pl',
      organization: example.organization,
      onOrganizationCreated: vi.fn(),
      onBack: vi.fn(),
      onCreated: vi.fn(),
    }),
  );
  const org = markup.match(/<input\b[^>]*aria-labelledby="new-salon-orgName-label"[^>]*>/)?.[0];
  const location = markup.match(
    /<input\b[^>]*aria-labelledby="new-salon-locationName-label"[^>]*>/,
  )?.[0];
  expect(org).toContain(`value="${example.expectedName}"`);
  expect(/\breadonly\b/i.test(org!)).toBe(example.locked);
  expect(location).toContain('value=""');
  expect(location).not.toMatch(/\breadonly\b/i);
});
