import { afterEach, expect, it, vi } from 'vitest';
import { csvTools, orderShareTools } from '../src/screens/csvTools';
import { shareCsv } from '../src/share';

const { platform, share } = vi.hoisted(() => ({
  platform: { OS: 'web' },
  share: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: platform, Share: { share } }));

const csv = '\uFEFFname,note,phone\r\n"Иван, Петров","Сказал ""да""\r\nНовая строка",\r\n';
const longField = 'Zażółć 🪮'.repeat(8192);
const delimitedFiles = [
  { fileName: 'semicolon.csv', content: `\uFEFFname;note\r\nAnna;"${longField};koniec"\r\n` },
  { fileName: 'tabs.tsv', content: `name\tnote\r\nAnna\t"${longField}\tend"\r\n` },
];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  { fileName: 'клиенты.csv', content: csv, type: undefined, mime: 'text/csv;charset=utf-8' },
  {
    fileName: 'клиент.json',
    content: '{"name":"Иван","phone":""}',
    type: 'application/json',
    mime: 'application/json',
  },
  { fileName: 'empty.csv', content: '', type: undefined, mime: 'text/csv;charset=utf-8' },
  ...delimitedFiles.map((file) => ({ ...file, type: undefined, mime: 'text/csv;charset=utf-8' })),
])(
  'downloads $fileName with its original bytes and MIME type',
  async ({ fileName, content, type, mime }) => {
    platform.OS = 'web';
    vi.useFakeTimers();
    const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
    const document = { createElement: vi.fn(() => anchor), body: { appendChild: vi.fn() } };
    vi.stubGlobal('document', document);
    const url = 'blob:export';
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue(url);
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const tools = csvTools(type);

    await expect(shareCsv({ fileName, csv: content }, tools)).resolves.toBe('downloaded');

    const blob = createUrl.mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe(mime);
    expect(Buffer.from(await blob.arrayBuffer()).equals(Buffer.from(content, 'utf8'))).toBe(true);
    expect(document.createElement).toHaveBeenCalledExactlyOnceWith('a');
    expect(anchor.href).toBe(url);
    expect(anchor.download).toBe(fileName);
    expect(document.body.appendChild).toHaveBeenCalledExactlyOnceWith(anchor);
    expect(document.body.appendChild).toHaveBeenCalledBefore(anchor.click);
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.click).toHaveBeenCalledBefore(anchor.remove);
    expect(anchor.remove).toHaveBeenCalledOnce();
    expect(tools.native).toBeUndefined();

    vi.advanceTimersByTime(999);
    expect(revokeUrl).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith(url);
  },
);

it.each([{ fileName: 'клиенты.csv', content: csv }, ...delimitedFiles])(
  'shares $fileName on a phone, omitting only the initial BOM if present',
  async ({ fileName, content }) => {
    platform.OS = 'android';
    share.mockResolvedValue({ action: 'sharedAction' });
    const tools = csvTools();

    await expect(shareCsv({ fileName, csv: content }, tools)).resolves.toBe('shared');
    const message = content.startsWith('\uFEFF') ? content.slice(1) : content;
    expect(share).toHaveBeenCalledExactlyOnceWith({ title: fileName, message });
    expect(tools.download).toBeUndefined();
  },
);

it('uses the phone share sheet for supplier orders', async () => {
  platform.OS = 'ios';
  share.mockResolvedValue({ action: 'dismissedAction' });
  const order = { title: 'Order', message: '2 × шампунь' };
  const tools = orderShareTools();

  await expect(tools.native?.(order)).resolves.toEqual({ action: 'dismissedAction' });
  expect(share).toHaveBeenCalledExactlyOnceWith(order);
});

it('offers only clipboard access when the browser lacks a share menu', async () => {
  platform.OS = 'web';
  const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
  vi.stubGlobal('navigator', { clipboard });
  const tools = orderShareTools();

  await expect(tools.copy?.('2 × шампунь')).resolves.toBeUndefined();
  expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith('2 × шампунь');
  expect(clipboard.writeText.mock.contexts[0]).toBe(clipboard);
  expect(tools.webShare).toBeUndefined();
  expect(tools.native).toBeUndefined();
});

it('passes the order title and text to the browser share menu', async () => {
  platform.OS = 'web';
  const browser = { share: vi.fn().mockResolvedValue(undefined) };
  vi.stubGlobal('navigator', browser);
  const data = { title: 'Order', text: '2 × шампунь' };
  const tools = orderShareTools();

  await expect(tools.webShare?.(data)).resolves.toBeUndefined();
  expect(browser.share).toHaveBeenCalledExactlyOnceWith(data);
  expect(browser.share.mock.contexts[0]).toBe(browser);
  expect(tools.copy).toBeUndefined();
});
