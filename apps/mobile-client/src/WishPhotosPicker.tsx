import * as ImagePicker from 'expo-image-picker';
import { memo, useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import {
  ApiError,
  MAX_WISH_PHOTOS,
  type ClientApi,
  type ClientAppointment,
  type Hold,
  type Locale,
  type VisitPhoto,
  type VisitPhotoList,
} from './api';
import { API_URL } from './config';
import { errorText, formFailure, isNetworkError, type FormFailure } from './errors';
import { FieldGroup, FormFeedback } from './FormFeedback';
import { formatDate } from './format';
import { fill, type Dictionary } from './i18n';
import { recentReads } from './shop';
import { Button, colors } from './ui';
import { photoType } from './wishes';

const holdLists = recentReads<VisitPhotoList>();
const visitLists = recentReads<VisitPhotoList>();
const PHOTO_TIMEOUT_MS = 30_000;

// The photo endpoints do not accept an AbortSignal. Ignore late responses after showing retry.
async function photoRequest<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ApiError(408, 'Photo request timed out')),
          PHOTO_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Presses can arrive together before React has rendered the disabled button.
function usePhotoAction() {
  const running = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => () => running.current?.abort(), []);
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (running.current) return;
    const controller = new AbortController();
    running.current = controller;
    setBusy(true);
    try {
      await action(controller.signal);
    } finally {
      running.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return { busy, run };
}

/**
 * Task 80f: "Pokaż, co chcesz" in the app — up to 3 example photos from the phone's gallery
 * (a haircut from Instagram…), added to the held time on the code step; they stay with the
 * visit once it is booked. Only for services where the salon asks for photos.
 */
export function WishPhotosPicker(props: { t: Dictionary; api: ClientApi; hold: Hold }) {
  const { t, api, hold } = props;
  const w = t.wishStep;
  const [photos, setPhotos] = useState<VisitPhoto[]>([]);
  const { busy, run } = usePhotoAction();
  const [failedUpload, setFailedUpload] = useState<{
    asset: ImagePicker.ImagePickerAsset;
    failure: FormFailure;
  } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadAttempt, retryLoad] = useState(0);
  const [failure, setFailure] = useState<FormFailure | null>(null);

  const tRef = useRef(t);
  tRef.current = t;

  const holdRef = useRef(hold);
  holdRef.current = hold;
  const holdKey = JSON.stringify([hold.holdId, hold.holdToken]);
  useEffect(() => {
    let live = true;
    holdLists
      .read(api, holdKey, () => photoRequest(api.holdPhotos(holdRef.current)))
      .then(
        ({ items }) => {
          if (!live) return;
          setPhotos(items);
          setLoaded(true);
        },
        (error: unknown) => {
          if (!live) return;
          setFailure(
            formFailure(error, tRef.current, () => {
              setFailure(null);
              retryLoad((attempt) => attempt + 1);
            }),
          );
        },
      );
    return () => {
      live = false;
    };
  }, [api, holdKey, loadAttempt]);

  function problem(err: unknown): string {
    if (err instanceof ApiError) {
      if (err.code === 'TOO_MANY_PHOTOS') return w.photosTooMany;
      if (err.code === 'PHOTO_TOO_LARGE') return w.photosTooLarge;
      if (err.code === 'UNSUPPORTED_PHOTO') return w.photosBadType;
    }
    return errorText(err, t);
  }

  async function add(signal: AbortSignal) {
    const left = MAX_WISH_PHOTOS - photos.length;
    if (left <= 0) return;
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: left > 1,
      selectionLimit: left,
      // Smaller files: the API takes at most 3 MB per photo.
      quality: 0.6,
    }).catch(() => null);
    if (signal.aborted) return;
    if (!picked) {
      setFailure({ message: w.photosNoAccess });
      return;
    }
    if (picked.canceled || picked.assets.length === 0) {
      return;
    }
    await upload(signal, picked.assets.slice(0, left));
  }

  async function upload(
    signal: AbortSignal,
    assets: ImagePicker.ImagePickerAsset[],
    knownIds = photos.map((photo) => photo.id),
    reconcile = false,
  ) {
    setFailure(null);
    setFailedUpload(null);
    holdLists.clear(api, holdKey);
    let pending = assets;
    let postStarted = reconcile;
    try {
      if (reconcile) {
        const { items } = await photoRequest(api.holdPhotos(hold));
        if (signal.aborted) return;
        setPhotos(items);
        // A lost response may have hidden a successful upload of the first pending photo.
        if (items.some((photo) => !knownIds.includes(photo.id))) pending = pending.slice(1);
        knownIds = items.map((photo) => photo.id);
      }
      while (pending.length > 0) {
        const asset = pending[0]!;
        postStarted = false;
        const blob =
          asset.file ??
          (await photoRequest<Blob>(
            fetch(asset.uri, { signal }).then((response) => response.blob()),
          ));
        if (signal.aborted) return;
        postStarted = true;
        const saved = await photoRequest(
          api.addHoldPhoto(hold, blob, photoType(asset.mimeType, blob.type)),
        );
        if (signal.aborted) return;
        pending = pending.slice(1);
        knownIds.push(saved.id);
        setPhotos((list) => [...list, saved]);
      }
    } catch (err) {
      if (signal.aborted) return;
      setFailedUpload({
        asset: pending[0]!,
        failure: formFailure(
          err,
          t,
          () => void run((retrySignal) => upload(retrySignal, pending, knownIds, postStarted)),
          problem(err),
        ),
      });
    } finally {
      holdLists.clear(api, holdKey);
    }
  }

  async function remove(signal: AbortSignal, id: string, reconcile = false) {
    setFailure(null);
    try {
      if (
        !reconcile ||
        (await photoRequest(api.holdPhotos(hold))).items.some((photo) => photo.id === id)
      ) {
        if (signal.aborted) return;
        await photoRequest(api.removeHoldPhoto(hold, id));
      }
      if (signal.aborted) return;
      setPhotos((list) => list.filter((p) => p.id !== id));
    } catch (err) {
      if (signal.aborted) return;
      setFailure(
        formFailure(
          err,
          t,
          () => void run((retrySignal) => remove(retrySignal, id, true)),
          problem(err),
        ),
      );
    } finally {
      holdLists.clear(api, holdKey);
    }
  }

  return (
    <View role="region" accessibilityLabel={w.photosQ} style={styles.box}>
      <Text role="heading" aria-level={3} style={styles.title}>
        📷 {w.photosQ}
      </Text>
      <Text style={styles.lead}>{w.photosLead}</Text>
      <FieldGroup error={failure?.retry ? undefined : failure?.message}>
        <PhotoThumbs
          t={t}
          photos={photos}
          busy={busy}
          onRemove={(id) => void run((signal) => remove(signal, id))}
        />
        <FormFeedback failure={failure?.retry ? failure : null} retryLabel={t.retry} busy={busy} />
        {failedUpload ? (
          <FieldGroup error={failedUpload.failure.retry ? undefined : failedUpload.failure.message}>
            <Image
              source={{ uri: failedUpload.asset.uri }}
              accessible
              accessibilityLabel={fill(w.photoAlt, { n: String(photos.length + 1) })}
              style={styles.photo}
            />
            <FormFeedback
              failure={failedUpload.failure.retry ? failedUpload.failure : null}
              retryLabel={t.retry}
              busy={busy}
            />
          </FieldGroup>
        ) : null}
        {loaded && !failedUpload?.failure.retry && photos.length < MAX_WISH_PHOTOS ? (
          <Button
            kind="secondary"
            label={busy ? w.photosUploading : w.photosAdd}
            disabled={busy}
            onPress={() => void run(add)}
          />
        ) : null}
      </FieldGroup>
    </View>
  );
}

const PhotoPreview = memo(function PhotoPreview({
  url,
  alt,
  t,
}: {
  url: string;
  alt: string;
  t: Dictionary;
}) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const retry = () => {
    setAttempt((n) => n + 1);
    setFailed(false);
  };
  if (failed) {
    return (
      <View style={styles.item}>
        <Text>{alt}</Text>
        <FormFeedback failure={{ message: t.error.network, retry }} retryLabel={t.retry} />
      </View>
    );
  }
  const suffix = attempt ? `${url.includes('?') ? '&' : '?'}retry=${attempt}` : '';
  return (
    <Image
      source={{ uri: `${API_URL}${url}${suffix}` }}
      onLoadStart={() => {
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setFailed(true), PHOTO_TIMEOUT_MS);
      }}
      onLoadEnd={() => clearTimeout(timer.current)}
      onError={() => setFailed(true)}
      accessible
      accessibilityLabel={alt}
      resizeMethod="resize"
      style={styles.photo}
    />
  );
});

/** The client's photos as thumbnails, each with "Usuń" when it can still be removed. */
function PhotoThumbs(props: {
  t: Dictionary;
  photos: VisitPhoto[];
  busy: boolean;
  onRemove?: (id: string) => void;
}) {
  const { t, photos, busy, onRemove } = props;
  const w = t.wishStep;
  if (photos.length === 0) return null;
  return (
    <View style={styles.row} accessibilityLabel={w.photosQ}>
      {photos.map((p, i) => {
        const alt = fill(w.photoAlt, { n: String(i + 1) });
        return (
          <View key={p.id} style={styles.item}>
            <PhotoPreview key={p.url} url={p.url} alt={alt} t={t} />
            {onRemove ? (
              <Button
                kind="link"
                label={w.photosRemove}
                a11yLabel={`${w.photosRemove}: ${alt}`}
                disabled={busy}
                onPress={() => onRemove(p.id)}
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/**
 * Task 80j: the example photos of one of my visits in "My visits" — removable until the visit
 * starts, with the date they are deleted. Nothing is shown when the visit has no photos.
 */
type VisitPhotoProps = {
  t: Dictionary;
  api: ClientApi;
  locale: Locale;
  visit: Pick<ClientAppointment, 'id' | 'timezone' | 'canChangeWishes'>;
};
export function VisitPhotos(props: VisitPhotoProps) {
  return <VisitPhotoCard key={props.visit.id} {...props} />;
}

function VisitPhotoCard(props: VisitPhotoProps) {
  const { t, api, locale, visit } = props;
  const w = t.wishStep;
  const [list, setList] = useState<VisitPhotoList | null>(null);
  const { busy, run } = usePhotoAction();
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const [loadAttempt, retryLoad] = useState(0);

  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => {
    let live = true;
    visitLists
      .read(api, visit.id, () => photoRequest(api.visitPhotos(visit.id)))
      .then(
        (photos) => live && setList(photos),
        (error: unknown) => {
          if (live && isNetworkError(error)) {
            setFailure(
              formFailure(error, tRef.current, () => {
                setFailure(null);
                retryLoad((attempt) => attempt + 1);
              }),
            );
          }
        },
      );
    return () => {
      live = false;
    };
  }, [api, visit.id, loadAttempt]);

  async function remove(signal: AbortSignal, id: string, reconcile = false) {
    setFailure(null);
    try {
      if (
        !reconcile ||
        (await photoRequest(api.visitPhotos(visit.id))).items.some((photo) => photo.id === id)
      ) {
        if (signal.aborted) return;
        await photoRequest(api.removeVisitPhoto(visit.id, id));
      }
      if (signal.aborted) return;
      setList((l) => (l ? { ...l, items: l.items.filter((p) => p.id !== id) } : l));
    } catch (err) {
      if (signal.aborted) return;
      setFailure(
        formFailure(err, t, () => void run((retrySignal) => remove(retrySignal, id, true))),
      );
    } finally {
      visitLists.clear(api, visit.id);
    }
  }

  if (!list?.items.length && !failure) return null;
  return (
    <View role="region" accessibilityLabel={w.photosQ} style={styles.box}>
      <Text role="heading" aria-level={2} style={styles.title}>
        📷 {w.photosQ}
      </Text>
      <FieldGroup error={failure?.retry ? undefined : failure?.message}>
        <PhotoThumbs
          t={t}
          photos={list?.items ?? []}
          busy={busy}
          onRemove={
            visit.canChangeWishes ? (id) => void run((signal) => remove(signal, id)) : undefined
          }
        />
        {list?.deleteAfter ? (
          <Text style={styles.lead}>
            {fill(w.photosKeptUntil, {
              date: formatDate(list.deleteAfter, visit.timezone, locale),
            })}
          </Text>
        ) : null}
      </FieldGroup>
      <FormFeedback failure={failure?.retry ? failure : null} retryLabel={t.retry} busy={busy} />
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
  item: { maxWidth: '100%', alignItems: 'center', gap: 2 },
  photo: { width: 96, height: 120, borderRadius: 10, backgroundColor: colors.line },
});
