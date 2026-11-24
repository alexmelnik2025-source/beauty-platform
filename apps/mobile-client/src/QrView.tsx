import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import { encodeQr, qrRuns } from './qr';

/** Light border around the code (4 modules, as the standard asks) — scanners need it. */
const QUIET = 4;

// The salon's disclosure unmounts the graphic when closed. Keep just the last public QR.
let lastGraphic: ReturnType<typeof buildGraphic> | undefined;

function buildGraphic(text: string) {
  const qr = encodeQr(text);
  const runs = qrRuns(qr);
  const modules = qr.size + QUIET * 2;
  const percent = (count: number): `${number}%` => `${(count / modules) * 100}%`;
  const squares = runs.map((r) => ({
    key: `${r.x}-${r.y}`,
    style: {
      left: percent(r.x + QUIET),
      top: percent(r.y + QUIET),
      width: percent(r.length),
      height: percent(1),
    },
  }));
  return { text, modules, squares };
}

/**
 * Task 357: a QR code drawn with plain Views — one per horizontal run of dark modules, so no
 * react-native-svg is needed. `module` is the preferred size of one square in pixels.
 */
export const QrView = memo(function QrView(props: {
  text: string;
  label: string;
  module?: number;
}) {
  const { text, label } = props;
  const module = props.module ?? 6;
  if (lastGraphic?.text !== text) lastGraphic = buildGraphic(text);
  const { modules, squares } = lastGraphic;
  return (
    <View
      accessible
      role="img"
      accessibilityLabel={label}
      testID="salon-qr"
      style={[styles.qr, { width: modules * module, maxWidth: '100%', aspectRatio: 1 }]}
    >
      {squares.map((square) => (
        <View key={square.key} style={[styles.module, square.style]} />
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  qr: { backgroundColor: '#fff', position: 'relative', alignSelf: 'center' },
  module: { position: 'absolute', backgroundColor: '#000' },
});
