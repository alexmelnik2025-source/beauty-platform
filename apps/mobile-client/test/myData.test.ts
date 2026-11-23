import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveMyData } from '../src/myData';

const { Platform, share } = vi.hoisted(() => ({
  Platform: { OS: 'ios' },
  share: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform, Share: { share } }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  share.mockReset();
});

describe('saveMyData', () => {
  const json = '{"visits":[]}';

  it('hands the JSON to the native share sheet', async () => {
    Platform.OS = 'android';
    await saveMyData(json, 'my-data.json', 'My data');
    expect(share).toHaveBeenCalledWith(
      { title: 'My data', message: json },
      { subject: 'my-data.json', dialogTitle: 'My data' },
    );
  });

  it('downloads the JSON file in the browser and revokes its object URL', async () => {
    Platform.OS = 'web';
    vi.useFakeTimers();
    const link = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
    const append = vi.fn();
    vi.stubGlobal('document', { createElement: () => link, body: { append } });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:my-data');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    await saveMyData(json, 'my-data.json', 'My data');

    const [blob] = create.mock.calls[0]!;
    expect((blob as Blob).type).toBe('application/json');
    expect(await (blob as Blob).text()).toBe(json);
    expect(append).toHaveBeenCalledWith(link);
    expect(link).toMatchObject({ href: 'blob:my-data', download: 'my-data.json' });
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.remove).toHaveBeenCalledOnce();
    expect(share).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(revoke).toHaveBeenCalledWith('blob:my-data');
  });
});
