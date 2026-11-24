import { afterEach, expect, it, vi } from 'vitest';
import { shareTools } from '../src/screens/shareTools';
import { shareMessage, shareSalon } from '../src/share';

const { platform, share, nativeShare, setString } = vi.hoisted(() => {
  const share = vi.fn();
  const nativeShare: { share?: typeof share } = { share };
  return { platform: { OS: 'web' }, share, nativeShare, setString: vi.fn() };
});

vi.mock('react-native', () => ({
  Platform: platform,
  Share: nativeShare,
  Clipboard: { setString },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  nativeShare.share = share;
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
  expect(setString).not.toHaveBeenCalled();
});

it('copies on a phone without a share function', async () => {
  platform.OS = 'android';
  delete nativeShare.share;
  const content = shareMessage('{name}: {url}', 'Salon', 'https://example.com/salon');
  await expect(shareSalon(content, shareTools(), 'message')).resolves.toBe('copied');
  expect(setString).toHaveBeenCalledExactlyOnceWith(content.message);
});

it('copies on a browser device without a share menu', async () => {
  platform.OS = 'web';
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const content = shareMessage('{name}: {url}', 'Salon', 'https://example.com/salon');
  await expect(shareSalon(content, shareTools())).resolves.toBe('copied');
  expect(writeText).toHaveBeenCalledExactlyOnceWith(content.url);
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

it.each([undefined, {}, { clipboard: {} }])('handles missing browser APIs (%j)', (browser) => {
  platform.OS = 'web';
  vi.stubGlobal('navigator', browser);

  expect(shareTools()).toEqual({ webShare: undefined, copy: undefined });
});
