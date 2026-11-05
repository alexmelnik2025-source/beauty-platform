import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { ApiError, MAX_WISH_PHOTOS, type ClientApi, type Hold, type VisitPhoto } from './api';
import { API_URL } from './config';
import { errorText } from './errors';
import { fill, type Dictionary } from './i18n';
import { Button, colors, ErrorText } from './ui';
import { photoType } from './wishes';

/**
 * Task 80f: "Pokaż, co chcesz" in the app — up to 3 example photos from the phone's gallery
 * (a haircut from Instagram…), added to the held time on the code step; they stay with the
 * visit once it is booked. Only for services where the salon asks for photos.
 */
export function WishPhotosPicker(props: { t: Dictionary; api: ClientApi; hold: Hold }) {
  const { t, api, hold } = props;
  const w = t.wishStep;
  const [photos, setPhotos] = useState<VisitPhoto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function problem(err: unknown): string {
    if (err instanceof ApiError) {
      if (err.code === 'TOO_MANY_PHOTOS') return w.photosTooMany;
      if (err.code === 'PHOTO_TOO_LARGE') return w.photosTooLarge;
      if (err.code === 'UNSUPPORTED_PHOTO') return w.photosBadType;
    }
    return errorText(err, t);
  }

  async function add() {
    setError('');
    const left = MAX_WISH_PHOTOS - photos.length;
    if (left <= 0) return;
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: left > 1,
      selectionLimit: left,
      // Smaller files: the API takes at most 3 MB per photo.
      quality: 0.6,
    }).catch(() => null);
    if (!picked) {
      setError(w.photosNoAccess);
      return;
    }
    if (picked.canceled || picked.assets.length === 0) return;
    setBusy(true);
    try {
      let count = photos.length;
      for (const asset of picked.assets) {
        if (count >= MAX_WISH_PHOTOS) {
          setError(w.photosTooMany);
          break;
        }
        const blob = await (await fetch(asset.uri)).blob();
        const saved = await api.addHoldPhoto(hold, blob, photoType(asset.mimeType, blob.type));
        count += 1;
        setPhotos((list) => [...list, saved]);
      }
    } catch (err) {
      setError(problem(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError('');
    try {
      await api.removeHoldPhoto(hold, id);
      setPhotos((list) => list.filter((p) => p.id !== id));
    } catch (err) {
      setError(problem(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.box}>
      <Text role="heading" aria-level={3} style={styles.title}>
        📷 {w.photosQ}
      </Text>
      <Text style={styles.lead}>{w.photosLead}</Text>
      {photos.length > 0 ? (
        <View style={styles.row} accessibilityLabel={w.photosQ}>
          {photos.map((p, i) => {
            const alt = fill(w.photoAlt, { n: String(i + 1) });
            return (
              <View key={p.id} style={styles.item}>
                <Image
                  source={{ uri: `${API_URL}${p.url}` }}
                  accessibilityLabel={alt}
                  accessibilityRole="image"
                  style={styles.photo}
                />
                <Button
                  kind="link"
                  label={w.photosRemove}
                  a11yLabel={`${w.photosRemove}: ${alt}`}
                  disabled={busy}
                  onPress={() => void remove(p.id)}
                />
              </View>
            );
          })}
        </View>
      ) : null}
      {photos.length < MAX_WISH_PHOTOS ? (
        <Button
          kind="secondary"
          label={busy ? w.photosUploading : w.photosAdd}
          disabled={busy}
          onPress={() => void add()}
        />
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    gap: 10,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
  },
  title: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  lead: { color: colors.muted, fontSize: 13 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  item: { alignItems: 'center', gap: 2 },
  photo: { width: 96, height: 120, borderRadius: 10, backgroundColor: colors.line },
});
