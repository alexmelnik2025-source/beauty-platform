import type { Prisma } from '../../generated/prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * Task Q4: what an imported product writes into the salon — the same for Base and for feeds.
 */
export interface SellerProductInput {
  /** "base:<inventory>:<id>" or "feed:<key>": the product in the seller's own system. */
  externalRef: string;
  name: string;
  brand: string | null;
  ean: string | null;
  description: string | null;
  priceGrosze: number;
  stockQuantity: number | null;
  /** "też online w Sklepie"; it is always on the salon's own page. */
  online: boolean;
  /** Written as the note of stock changes: "Base" or "Plik". */
  source: string;
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';

/** The code on the package as the catalogue keeps it (digits of EAN-8/UPC/EAN-13/GTIN-14). */
export const normalEan = (value: string | null): string | null => {
  const digits = value?.replace(/[\s-]+/g, '') ?? '';
  return /^\d{8}$|^\d{12,14}$/.test(digits) ? digits : null;
};

/** Sellers keep descriptions as HTML; the catalogue keeps plain text. */
export const plainText = (html: string | null, max: number): string | null => {
  if (!html) return null;
  const text = html
    .replace(/<\s*(br|\/p|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text ? text.slice(0, max).trim() : null;
};

export const cut = (value: string, max: number) => value.trim().slice(0, max).trim();

/**
 * One imported product becomes (or renews) the salon's product: the product imported before
 * from the same place, or the salon's own product with the same code, or a new one; joined to
 * the platform card with the same EAN, or to a new card. On the salon's page; online if asked.
 */
export async function upsertSellerProduct(
  prisma: PrismaService,
  userId: string,
  locationId: string,
  p: SellerProductInput,
  attempt = 0,
): Promise<{
  product: 'created' | 'updated';
  card: 'created' | 'matched' | 'kept';
  catalogProductId: string;
}> {
  return prisma
    .$transaction(async (tx) => {
      // The same product imported before, or the salon's own product with the same code.
      const existing =
        (await tx.product.findFirst({ where: { locationId, externalRef: p.externalRef } })) ??
        (p.ean
          ? await tx.product.findFirst({
              where: { locationId, barcode: p.ean, externalRef: null },
            })
          : null);
      // Another imported product of this salon already carries the code: this one goes without it.
      const barcodeFree =
        p.ean &&
        !(await tx.product.findFirst({
          where: { locationId, barcode: p.ean, NOT: existing ? { id: existing.id } : undefined },
          select: { id: true },
        }));
      const barcode = barcodeFree ? p.ean : (existing?.barcode ?? null);

      let card: 'created' | 'matched' | 'kept' = 'kept';
      let catalogProductId = existing?.catalogProductId ?? null;
      if (!catalogProductId) {
        const found = p.ean
          ? await tx.catalogProduct.findUnique({ where: { ean: p.ean }, select: { id: true } })
          : null;
        if (found) {
          catalogProductId = found.id;
          card = 'matched';
        } else {
          catalogProductId = (
            await tx.catalogProduct.create({
              data: {
                name: p.name,
                brand: p.brand,
                ean: p.ean,
                description: p.description,
                createdByLocationId: locationId,
              },
              select: { id: true },
            })
          ).id;
          card = 'created';
        }
      }

      const data = {
        name: p.name,
        priceGrosze: p.priceGrosze,
        stockQuantity: p.stockQuantity,
        barcode,
        externalRef: p.externalRef,
        catalogProductId,
        active: true,
        inSalonShop: true,
        inMarketplace: p.online,
      } satisfies Prisma.ProductUncheckedUpdateInput;
      if (existing) {
        await tx.product.update({ where: { id: existing.id }, data });
        if (existing.stockQuantity !== p.stockQuantity) {
          await stockMoved(
            tx,
            existing.id,
            existing.stockQuantity,
            p.stockQuantity,
            userId,
            p.source,
          );
        }
        return { product: 'updated' as const, card, catalogProductId };
      }
      const created = await tx.product.create({ data: { ...data, locationId } });
      if (p.stockQuantity !== null && p.stockQuantity > 0) {
        await stockMoved(tx, created.id, null, p.stockQuantity, userId, p.source);
      }
      return { product: 'created' as const, card, catalogProductId };
    })
    .catch(async (error: unknown) => {
      // Another import made the same card or product a moment ago: once more finds it.
      if (isUniqueViolation(error) && attempt === 0) {
        return upsertSellerProduct(prisma, userId, locationId, p, 1);
      }
      throw error;
    });
}

/** The pieces the seller's system reports, written down as a correction (task 440's history). */
export function stockMoved(
  tx: Prisma.TransactionClient,
  productId: string,
  before: number | null,
  after: number | null,
  userId: string | null,
  note: string,
) {
  return tx.stockMovement.create({
    data: {
      productId,
      kind: 'correction',
      change: (after ?? 0) - (before ?? 0),
      quantityAfter: after,
      createdByUserId: userId,
      note,
    },
  });
}
