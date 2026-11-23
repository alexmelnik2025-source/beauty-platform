import { afterEach, expect, it, vi } from 'vitest';
import { shareTools } from '../src/screens/shareTools';

const { platform, share } = vi.hoisted(() => ({
  platform: { OS: 'web' },
  share: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: platform, Share: { share } }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it('passes the message and title to the phone share sheet with the link only in the message', async () => {
  platform.OS = 'ios';
  const url = 'https://example.com/salon';
  const message = 'Book at ' + url;
  share.mockResolvedValue({ action: 'sharedAction' });

  const tools = shareTools();

  await expect(tools.native?.({ title: 'Salon', message, url })).resolves.toEqual({
    action: 'sharedAction',
  });
  expect(share).toHaveBeenCalledExactlyOnceWith({ title: 'Salon', message });
  expect(tools.webShare).toBeUndefined();
  expect(tools.copy).toBeUndefined();
});

it('forwards browser share and clipboard calls with their original receivers', async () => {
  platform.OS = 'web';
  const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
  const browser = { share: vi.fn().mockResolvedValue(undefined), clipboard };
  vi.stubGlobal('navigator', browser);
  const data = { title: 'Salon', text: 'Book a visit', url: 'https://example.com/salon' };

  const tools = shareTools();

  await expect(tools.webShare?.(data)).resolves.toBeUndefined();
  await expect(tools.copy?.(data.url)).resolves.toBeUndefined();
  expect(browser.share).toHaveBeenCalledExactlyOnceWith(data);
  expect(browser.share.mock.contexts[0]).toBe(browser);
  expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith(data.url);
  expect(clipboard.writeText.mock.contexts[0]).toBe(clipboard);
  expect(tools.native).toBeUndefined();
});

it.each([undefined, {}])('handles missing browser APIs (%j)', (browser) => {
  platform.OS = 'web';
  vi.stubGlobal('navigator', browser);

  expect(shareTools()).toEqual({ webShare: undefined, copy: undefined });
});
