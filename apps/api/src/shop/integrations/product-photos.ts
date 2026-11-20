import dns from 'node:dns';
import net from 'node:net';
import { MAX_PHOTO_BYTES, detectImageType } from '../../scheduling/photos.service';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * Task Q4: the picture of an imported product (Base `images`, `g:image_link`, Ceneo `<main
 * url>`, the "zdjęcie" column of a CSV) becomes the photo of its platform card — only when the
 * card has none yet, so a picture a salon chose is never replaced.
 *
 * The address comes from the seller, so it is fetched carefully: http(s) only, standard ports,
 * never an address inside a private network (checked again after every redirect), a few seconds
 * at most, at most MAX_PHOTO_BYTES, and kept only if its first bytes are a JPEG, PNG or WebP.
 */

const FETCH_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;
/** Pictures fetched at the same time during one import. */
const PARALLEL = 6;
/** An import waits for pictures at most this long; the rest come with the next import. */
const IMPORT_BUDGET_MS = 25_000;

/** True for an address on the public internet (not loopback, private, link-local, …). */
export function isPublicAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return isPublicAddress(mapped[1]);
    return !(
      lower === '::' ||
      lower === '::1' ||
      /^f[cd]/.test(lower) ||
      /^fe[89ab]/.test(lower) ||
      /^ff/.test(lower) ||
      lower.startsWith('::ffff:')
    );
  }
  return false;
}

/** The address as a URL worth fetching, or null (another scheme, a port, a password, …). */
const acceptableUrl = (raw: string): URL | null => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.port !== '' || url.username !== '' || url.password !== '') return null;
  return url;
};

const hostIsPublic = async (url: URL): Promise<boolean> => {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return isPublicAddress(host);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  try {
    const found = await dns.promises.lookup(host, { all: true });
    return found.length > 0 && found.every((f) => isPublicAddress(f.address));
  } catch {
    return false;
  }
};

/** The picture at the seller's address, or null when it cannot (or should not) be taken. */
export async function fetchProductImage(
  raw: string,
): Promise<{ bytes: Buffer; type: string } | null> {
  let url = acceptableUrl(raw);
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  try {
    for (let hop = 0; url && hop <= MAX_REDIRECTS; hop += 1) {
      if (!(await hostIsPublic(url))) return null;
      const response = await fetch(url, {
        redirect: 'manual',
        signal,
        headers: { Accept: 'image/jpeg, image/png, image/webp' },
      });
      if (response.status >= 300 && response.status < 400) {
        const next = response.headers.get('location');
        await response.body?.cancel();
        url = next ? acceptableUrl(new URL(next, url).toString()) : null;
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return null;
      }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_PHOTO_BYTES) {
        await response.body.cancel();
        return null;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > MAX_PHOTO_BYTES) return null;
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks);
      const type = detectImageType(bytes);
      return type ? { bytes, type } : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** One card that may get the picture of an imported product. */
export interface CardPicture {
  catalogProductId: string;
  imageUrl: string | null;
}

/**
 * Gives cards without a photo the picture from the seller's system; returns how many got one.
 * A failed picture is simply skipped — the import itself never fails because of it.
 */
export async function attachImportedPhotos(
  prisma: PrismaService,
  locationId: string,
  pictures: CardPicture[],
): Promise<number> {
  const wanted = new Map<string, string>();
  for (const p of pictures) {
    if (p.imageUrl && !wanted.has(p.catalogProductId)) wanted.set(p.catalogProductId, p.imageUrl);
  }
  if (wanted.size === 0) return 0;
  const withPhoto = await prisma.photo.findMany({
    where: { catalogProductId: { in: [...wanted.keys()] } },
    select: { catalogProductId: true },
  });
  for (const p of withPhoto) if (p.catalogProductId) wanted.delete(p.catalogProductId);

  const queue = [...wanted.entries()];
  const until = Date.now() + IMPORT_BUDGET_MS;
  let added = 0;
  const worker = async () => {
    for (let next = queue.shift(); next && Date.now() < until; next = queue.shift()) {
      const [catalogProductId, imageUrl] = next;
      const image = await fetchProductImage(imageUrl);
      if (!image) continue;
      try {
        await prisma.photo.create({
          data: {
            locationId,
            catalogProductId,
            contentType: image.type,
            sizeBytes: image.bytes.length,
            data: new Uint8Array(image.bytes),
          },
        });
        added += 1;
      } catch {
        // Someone gave the card a photo a moment ago: theirs stays.
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  return added;
}
