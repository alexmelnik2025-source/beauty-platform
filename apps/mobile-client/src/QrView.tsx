import { memo } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
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
  const content =
    Platform.OS === 'web' ? (
      <svg
        viewBox={`0 0 ${modules} ${modules}`}
        width="100%"
        height="100%"
        shapeRendering="crispEdges"
        aria-hidden="true"
        focusable="false"
      >
        <path
          fill="#000"
          d={runs
            .map(({ x, y, length }) => `M${x + QUIET} ${y + QUIET}h${length}v1h-${length}z`)
            .join('')}
        />
      </svg>
    ) : (
      runs.map(({ x, y, length }) => (
        <View
          key={`${x}-${y}`}
          style={[
            styles.module,
            {
              left: percent(x + QUIET),
              top: percent(y + QUIET),
              width: percent(length),
              height: percent(1),
            },
          ]}
        />
      ))
    );
  return { text, modules, content };
}

/** One vector path on the web. The native app draws the same horizontal runs with Views. */
export const QrView = memo(function QrView(props: {
  text: string;
  label: string;
  module?: number;
}) {
  const { text, label } = props;
  const module = props.module ?? 6;
  if (lastGraphic?.text !== text) lastGraphic = buildGraphic(text);
  const { modules, content } = lastGraphic;
  return (
    <View
      accessible
      role="img"
      accessibilityLabel={label}
      testID="salon-qr"
      style={[styles.qr, { width: modules * module, maxWidth: '100%', aspectRatio: 1 }]}
    >
      {content}
    </View>
  );
});

const styles = StyleSheet.create({
  qr: { backgroundColor: '#fff', position: 'relative', alignSelf: 'center' },
  module: { position: 'absolute', backgroundColor: '#000' },
});
