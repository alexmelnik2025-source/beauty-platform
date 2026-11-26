import { createElement, type ComponentProps, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../src/ui';

const nativePressable = vi.hoisted(() => vi.fn((_props: { onPress: () => unknown }) => null));
vi.mock('react-native', async () => ({
  ...(await vi.importActual<typeof import('react-native')>('react-native-web')),
  Pressable: nativePressable,
}));
const { renderToStaticMarkup } = await vi.importActual<{
  renderToStaticMarkup(node: ReactNode): string;
}>('react-dom/server');

function renderButton(props: ComponentProps<typeof Button>) {
  renderToStaticMarkup(createElement(Button, props));
  return nativePressable.mock.lastCall![0].onPress;
}

describe('business button submissions', () => {
  it.each([{ label: 'Save', busy: false }, { label: 'Retry' }])(
    'runs a single $label request and accepts another press after failure',
    async (props) => {
      let fail!: (error: Error) => void;
      const request = new Promise<void>((_resolve, reject) => {
        fail = reject;
      });
      const onPress = vi.fn(() => request);
      const press = renderButton({ ...props, onPress });
      const pending = press();
      press();
      await Promise.resolve();
      press();
      expect(onPress).toHaveBeenCalledTimes(1);

      fail(new Error('offline'));
      await expect(pending).rejects.toThrow('offline');
      onPress.mockResolvedValue(undefined);
      await press();
      expect(onPress).toHaveBeenCalledTimes(2);
    },
  );

  it('ignores a second activation in the same event when the form owns the busy state', async () => {
    const onPress = vi.fn();
    const press = renderButton({ label: 'Save', busy: false, onPress });
    const pending = press();
    press();
    expect(onPress).toHaveBeenCalledTimes(1);
    await pending;
    press();
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it.each([{ busy: true }, { busy: false, disabled: true }])(
    'ignores activation when unavailable (%o)',
    async (state) => {
      const onPress = vi.fn();
      await renderButton({ label: 'Save', onPress, ...state })();
      expect(onPress).not.toHaveBeenCalled();
    },
  );

  it('keeps ordinary actions synchronous and immediately repeatable', () => {
    const onPress = vi.fn();
    const press = renderButton({ label: 'Next', onPress });
    press();
    press();
    expect(onPress).toHaveBeenCalledTimes(2);
  });
});
