import { HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AppException, notFound } from '../../common/app-exception';
import type { MembershipContext } from '../../common/request-context';
import { LocationAccessService } from '../../organizations/location-access.service';
import { PrismaService } from '../../prisma/prisma.service';
import { parseFeed, type FeedRow } from './feed-parser';
import type {
  FeedImportResultResponse,
  FeedPreviewResponse,
  ImportFeedInput,
} from './feed.schemas';
import { attachImportedPhotos, type CardPicture } from './product-photos';
import { cut, normalEan, plainText, upsertSellerProduct } from './seller-products';

/** The largest file a seller may send. */
export const MAX_FEED_BYTES = 10 * 1024 * 1024;

/** The most products one file may hold (more → split it). */
export const MAX_FEED_ROWS = 5000;

/** A sent file is kept this long for the seller to tick and import from it. */
const KEEP_MS = 24 * 60 * 60_000;

const FEED_TYPES =
  /^(text\/(csv|plain|xml|tab-separated-values)|application\/(xml|rss\+xml|atom\+xml|csv|vnd\.ms-excel|octet-stream))\b/i;

const tooLarge = (): AppException =>
  new AppException(
    HttpStatus.PAYLOAD_TOO_LARGE,
    'FEED_TOO_LARGE',
    `The file may be at most ${MAX_FEED_BYTES / 1024 / 1024} MB and ${MAX_FEED_ROWS} products`,
  );

const unsupported = (): AppException =>
  new AppException(
    HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    'UNSUPPORTED_FEED',
    'Send the file itself: CSV or XML (Google Merchant, Ceneo)',
  );

const empty = (): AppException =>
  new AppException(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'FEED_EMPTY',
    'No product with a name and an id was found in the file',
  );

/** Text of the file: UTF-8, or Windows-1250 (Polish Excel's CSV) when it is not valid UTF-8. */
export function decodeFeed(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1250').decode(bytes);
  }
}

async function readFeedBody(req: Request): Promise<Buffer> {
  if (!FEED_TYPES.test(req.headers['content-type'] ?? '')) throw unsupported();
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_FEED_BYTES) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_FEED_BYTES) throw tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const toGrosze = (row: FeedRow, salonCurrency: string): number | null =>
  row.price === null || (row.currency !== null && row.currency !== salonCurrency.toUpperCase())
    ? null
    : Math.round(row.price * 100);

/**
 * Task Q4 (part 3): "Integracje" → "Importuj z pliku" for sellers without Base: the seller sends
 * its product file (Google Merchant XML, Ceneo XML, CSV), sees what was read, ticks products and
 * imports them the same way as from Base (joined to the platform card by EAN, nothing published
 * by itself). The file is kept for a day. Owners and managers only.
 */
@Injectable()
export class ShopFeedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LocationAccessService,
  ) {}

  async upload(
    m: MembershipContext,
    userId: string,
    locationId: string,
    req: Request,
  ): Promise<FeedPreviewResponse> {
    const location = await this.access.writable(m, locationId);
    const parsed = parseFeed(decodeFeed(await readFeedBody(req)));
    if (parsed.rows.length === 0) throw empty();
    if (parsed.rows.length > MAX_FEED_ROWS) throw tooLarge();
    await this.prisma.shopFeedUpload.deleteMany({
      where: { locationId, createdAt: { lt: new Date(Date.now() - KEEP_MS) } },
    });
    const upload = await this.prisma.shopFeedUpload.create({
      data: {
        locationId,
        format: parsed.format,
        rows: parsed.rows as unknown as object[],
        unreadable: parsed.unreadable,
        createdByUserId: userId,
      },
    });
    const refs = parsed.rows.map((r) => `feed:${r.key}`);
    const eans = [...new Set(parsed.rows.map((r) => normalEan(r.ean)).filter((e) => e !== null))];
    const [imported, cards] = await Promise.all([
      this.prisma.product.findMany({
        where: { locationId, externalRef: { in: refs } },
        select: { id: true, externalRef: true, catalogProductId: true },
      }),
      this.prisma.catalogProduct.findMany({
        where: { ean: { in: eans } },
        select: { id: true, ean: true },
      }),
    ]);
    const byRef = new Map(imported.map((p) => [p.externalRef, p]));
    const cardByEan = new Map(cards.map((c) => [c.ean, c.id]));
    return {
      feedId: upload.id,
      format: parsed.format,
      unreadable: parsed.unreadable,
      products: parsed.rows.map((r) => {
        const mine = byRef.get(`feed:${r.key}`);
        const ean = normalEan(r.ean);
        return {
          key: r.key,
          name: r.name,
          ean,
          sku: r.sku,
          brand: r.brand,
          priceGrosze: toGrosze(r, location.currency),
          currency: r.currency,
          stock: r.stock,
          imageUrl: r.imageUrl,
          importedProductId: mine?.id ?? null,
          catalogProductId: mine?.catalogProductId ?? (ean ? (cardByEan.get(ean) ?? null) : null),
        };
      }),
    };
  }

  async import(
    m: MembershipContext,
    userId: string,
    locationId: string,
    feedId: string,
    input: ImportFeedInput,
  ): Promise<FeedImportResultResponse> {
    const location = await this.access.writable(m, locationId);
    const upload = await this.prisma.shopFeedUpload.findFirst({
      where: { id: feedId, locationId, createdAt: { gte: new Date(Date.now() - KEEP_MS) } },
    });
    if (!upload) throw notFound('Feed');
    const rows = new Map((upload.rows as unknown as FeedRow[]).map((r) => [r.key, r]));
    const result: FeedImportResultResponse = {
      created: 0,
      updated: 0,
      cardsCreated: 0,
      cardsMatched: 0,
      photosAdded: 0,
      skipped: [],
    };
    const pictures: CardPicture[] = [];
    for (const item of input.items) {
      const row = rows.get(item.key);
      if (!row) {
        result.skipped.push({ key: item.key, reason: 'NOT_IN_FEED' });
        continue;
      }
      const priceGrosze = toGrosze(row, location.currency);
      if (priceGrosze === null) {
        result.skipped.push({
          key: item.key,
          reason: row.price === null ? 'NO_PRICE' : 'OTHER_CURRENCY',
        });
        continue;
      }
      const outcome = await upsertSellerProduct(this.prisma, userId, locationId, {
        externalRef: `feed:${row.key}`,
        name: cut(row.name, 120),
        brand: row.brand ? cut(row.brand, 60) || null : null,
        ean: normalEan(row.ean),
        description: plainText(row.description, 2000),
        priceGrosze,
        stockQuantity: row.stock === null ? null : Math.min(100_000, row.stock),
        online: item.online,
        source: 'Plik',
      });
      result[outcome.product] += 1;
      if (outcome.card === 'created') result.cardsCreated += 1;
      if (outcome.card === 'matched') result.cardsMatched += 1;
      pictures.push({ catalogProductId: outcome.catalogProductId, imageUrl: row.imageUrl });
    }
    result.photosAdded = await attachImportedPhotos(this.prisma, locationId, pictures);
    return result;
  }
}
