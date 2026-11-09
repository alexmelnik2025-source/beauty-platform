import { useMemo, type ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';
import { encodeQr, qrRuns } from './qr';

/** Light border around the code (4 modules, as the standard asks) — scanners need it. */
const QUIET = 4;

/**
 * Task 357: a QR code drawn with plain Views — one per horizontal run of dark modules, so no
 * react-native-svg is needed. `module` is the size of one square in pixels.
 */
export function QrView(props: { text: string; label: string; module?: number }) {
  const { text, label } = props;
  const module = props.module ?? 6;
  const qr = useMemo(() => encodeQr(text), [text]);
  const runs = useMemo(() => qrRuns(qr), [qr]);
  const side = (qr.size + QUIET * 2) * module;
  const squares: ReactElement[] = runs.map((r) => (
    <View
      key={`${r.x}-${r.y}`}
      style={[
        styles.module,
        {
          left: (r.x + QUIET) * module,
          top: (r.y + QUIET) * module,
          width: r.length * module,
          height: module,
        },
      ]}
    />
  ));
  return (
    <View
      role="img"
      accessibilityLabel={label}
      testID="salon-qr"
      style={[styles.qr, { width: side, height: side }]}
    >
      {squares}
    </View>
  );
}

const styles = StyleSheet.create({
  qr: { backgroundColor: '#fff', position: 'relative', alignSelf: 'center' },
  module: { position: 'absolute', backgroundColor: '#000' },
});
