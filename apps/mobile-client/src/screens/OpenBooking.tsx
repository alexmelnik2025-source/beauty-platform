import { useEffect, useEffectEvent, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import type { ClientApi, PublicLocation } from '../api';
import { errorText } from '../errors';
import type { Dictionary } from '../i18n';
import { Button, colors, ErrorText, Heading } from '../ui';

/**
 * "Book again" and "Book" on a loyalty card: loads the salon's booking page data (services,
 * specialists) and hands it to the booking; on a failure — the reason and "try again".
 */
export function OpenBooking(props: {
  api: ClientApi;
  t: Dictionary;
  slug: string;
  name: string;
  onLoaded: (salon: PublicLocation) => void;
  onBack: () => void;
}) {
  const { api, slug, onLoaded } = props;
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const loaded = useEffectEvent(onLoaded);
  const failed = useEffectEvent((e: unknown) => setError(errorText(e, props.t)));

  useEffect(() => {
    let live = true;
    api.salon(slug).then(
      (salon) => {
        if (live) loaded(salon);
      },
      (e: unknown) => {
        if (live) failed(e);
      },
    );
    return () => {
      live = false;
    };
  }, [api, slug, attempt]);

  function retry() {
    setError('');
    setAttempt((n) => n + 1);
  }

  return (
    <View style={styles.screen}>
      <View style={styles.top}>
        <Button kind="link" label={props.t.book.back} onPress={props.onBack} />
      </View>
      <Heading>{props.name}</Heading>
      {error ? (
        <>
          <ErrorText>{error}</ErrorText>
          <Button kind="secondary" label={props.t.retry} onPress={retry} />
        </>
      ) : (
        <ActivityIndicator style={{ marginTop: 24 }} color={colors.ink} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 20, gap: 12 },
  top: { flexDirection: 'row', marginLeft: -8 },
});
