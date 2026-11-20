import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, notFound } from '../common/app-exception';
import type { MembershipContext } from '../common/request-context';
import type { CatalogProduct, Prisma } from '../generated/prisma/client';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CatalogProductResponse,
  CatalogSearchQuery,
  CatalogSearchResponse,
  CreateCatalogProductInput,
  PublicSalonProductsResponse,
  PublicShopListResponse,
  PublicShopProductResponse,
  PublicShopQuery,
  UpdateCatalogProductInput,
} from './shop.schemas';

/** Task Q3: another card already has this code on the package; its id is in the details. */
const eanTaken = (existingId: string): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'EAN_TAKEN',
    'A card with this EAN is already in the catalogue — offer that one instead',
    [{ path: 'ean', message: existingId }],
  );

/** Task Q3: a card another salon also offers belongs to everyone; only the platform changes it. */
const cardShared = (): AppException =>
  new AppException(
    HttpStatus.FORBIDDEN,
    'CARD_SHARED',
    'Another salon offers this card too, so it may not be changed here',
  );

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';

/** A salon's product that clients may see on the salon's own page. */
const salonShopWhere: Prisma.ProductWhereInput = { active: true, inSalonShop: true };

/** A salon's product that every client sees in the "Sklep" tab: the salon must be bookable too. */
const marketplaceWhere: Prisma.ProductWhereInput = {
  ...salonShopWhere,
  inMarketplace: true,
  location: { onlineBookingEnabled: true },
};

/** The salon counts its pieces and has none left. */
const available = (stockQuantity: number | null): boolean =>
  stockQuantity === null || stockQuantity > 0;

type CardWithPhoto = CatalogProduct & { photo: { id: string } | null };

const toCard = (c: CardWithPhoto) => ({
  id: c.id,
  name: c.name,
  brand: c.brand,
  ean: c.ean,
  description: c.description,
  category: c.category,
  photoId: c.photo?.id ?? null,
});

type OfferRow = Prisma.ProductGetPayload<{
  include: {
    location: {
      select: {
        slug: true;
        name: true;
        city: true;
        addressLine: true;
        currency: true;
        shopFulfillment: true;
      };
    };
  };
}>;

const toOffer = (p: OfferRow): PublicShopProductResponse['offers'][number] => ({
  productId: p.id,
  priceGrosze: p.priceGrosze,
  currency: p.location.currency,
  available: available(p.stockQuantity),
  // The launch allows pickup only, whatever a row says (shipping is a model, not a service yet).
  fulfillment: p.location.shopFulfillment.filter((f) => f === 'pickup_at_salon'),
  salon: {
    slug: p.location.slug,
    name: p.location.name,
    city: p.location.city,
    addressLine: p.location.addressLine,
  },
});

/** Available first, then the cheapest, then the salon's name: the same order everywhere. */
const byOffer = (a: OfferRow, b: OfferRow): number =>
  Number(available(b.stockQuantity)) - Number(available(a.stockQuantity)) ||
  a.priceGrosze - b.priceGrosze ||
  a.location.name.localeCompare(b.location.name) ||
  a.id.localeCompare(b.id);

/**
 * Task Q3 (part 1): the platform's shop. One card per product in the catalogue (`CatalogProduct`),
 * the same for everyone; a salon's own `Product` that points to a card is that salon's offer of it,
 * with the salon's price and stock (see ../booking/products.service.ts). Clients see a salon's
 * offers on its booking page ("Produkty salonu") and, when the salon also switched "Sprzedawaj też
 * online w Sklepie" on, in the "Sklep" tab with every other salon offering the same card.
 *
 * At the launch a client only puts a product aside and pays at the salon: no online payments, no
 * shipping (a model only). Stock numbers never leave the salon — clients see "available" or not.
 */
@Injectable()
export class ShopService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LocationAccessService,
  ) {}

  // ── The salon's side: the catalogue ─────────────────────

  /**
   * "Wybierz z katalogu": cards whose name or brand has the words, or whose EAN is the code
   * typed or scanned. Everyone in the salon may look (to pick a card for a product).
   */
  async search(
    m: MembershipContext,
    locationId: string,
    query: CatalogSearchQuery,
  ): Promise<CatalogSearchResponse> {
    await this.access.readable(m, locationId);
    const q = query.q?.trim();
    const code = q?.replace(/[\s-]+/g, '');
    const where: Prisma.CatalogProductWhereInput = q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { brand: { contains: q, mode: 'insensitive' } },
            ...(code && /^\d{8,14}$/.test(code) ? [{ ean: code }] : []),
          ],
        }
      : {};
    const cards = await this.prisma.catalogProduct.findMany({
      where,
      include: this.cardInclude(),
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: query.limit,
    });
    const exact = (c: CardWithPhoto) => (code && c.ean === code ? 0 : 1);
    return {
      products: cards
        .sort((a, b) => exact(a) - exact(b) || a.name.localeCompare(b.name))
        .map((c) => this.toCatalogProduct(c, locationId)),
    };
  }

  async get(
    m: MembershipContext,
    locationId: string,
    cardId: string,
  ): Promise<CatalogProductResponse> {
    await this.access.readable(m, locationId);
    const card = await this.prisma.catalogProduct.findUnique({
      where: { id: cardId },
      include: this.cardInclude(),
    });
    if (!card) throw notFound('CatalogProduct');
    return this.toCatalogProduct(card, locationId);
  }

  /** A new card, made by the salon (owners and managers). The same EAN twice → 409 EAN_TAKEN. */
  async create(
    m: MembershipContext,
    locationId: string,
    input: CreateCatalogProductInput,
  ): Promise<CatalogProductResponse> {
    await this.access.writable(m, locationId);
    if (input.ean) {
      const existing = await this.prisma.catalogProduct.findUnique({
        where: { ean: input.ean },
        select: { id: true },
      });
      if (existing) throw eanTaken(existing.id);
    }
    try {
      const card = await this.prisma.catalogProduct.create({
        data: { ...input, createdByLocationId: locationId },
        include: this.cardInclude(),
      });
      return this.toCatalogProduct(card, locationId);
    } catch (error: unknown) {
      if (isUniqueViolation(error) && input.ean) {
        const existing = await this.prisma.catalogProduct.findUnique({
          where: { ean: input.ean },
          select: { id: true },
        });
        if (existing) throw eanTaken(existing.id);
      }
      throw error;
    }
  }

  /**
   * The salon that made a card changes it while it is the only one offering it (403 CARD_SHARED
   * once another salon offers it; a card of another salon is not found at all).
   */
  async update(
    m: MembershipContext,
    locationId: string,
    cardId: string,
    input: UpdateCatalogProductInput,
  ): Promise<CatalogProductResponse> {
    await this.access.writable(m, locationId);
    const card = await this.prisma.catalogProduct.findUnique({
      where: { id: cardId },
      include: this.cardInclude(),
    });
    if (!card || card.createdByLocationId !== locationId) throw notFound('CatalogProduct');
    if (!this.editable(card, locationId)) throw cardShared();
    if (input.ean && input.ean !== card.ean) {
      const existing = await this.prisma.catalogProduct.findUnique({
        where: { ean: input.ean },
        select: { id: true },
      });
      if (existing) throw eanTaken(existing.id);
    }
    const updated = await this.prisma.catalogProduct.update({
      where: { id: cardId },
      data: input,
      include: this.cardInclude(),
    });
    return this.toCatalogProduct(updated, locationId);
  }

  private cardInclude() {
    return {
      photo: { select: { id: true } },
      offers: { where: { active: true }, select: { id: true, locationId: true } },
    } satisfies Prisma.CatalogProductInclude;
  }

  private editable(
    card: CatalogProduct & { offers: { locationId: string }[] },
    locationId: string,
  ): boolean {
    return (
      card.createdByLocationId === locationId &&
      card.offers.every((o) => o.locationId === locationId)
    );
  }

  private toCatalogProduct(
    card: CardWithPhoto & { offers: { id: string; locationId: string }[] },
    locationId: string,
  ): CatalogProductResponse {
    return {
      ...toCard(card),
      sellers: new Set(card.offers.map((o) => o.locationId)).size,
      editable: this.editable(card, locationId),
      offeredHere: card.offers.find((o) => o.locationId === locationId)?.id ?? null,
    };
  }

  // ── The client's side ───────────────────────────────────

  /** "Produkty salonu": what this salon sells to its clients, to pick up at a visit. */
  async salonProducts(slug: string): Promise<PublicSalonProductsResponse> {
    const location = await this.prisma.location.findUnique({
      where: { slug: slug.toLowerCase() },
      select: { id: true, onlineBookingEnabled: true, currency: true, shopFulfillment: true },
    });
    if (!location || !location.onlineBookingEnabled) throw notFound('Salon');
    const products = await this.prisma.product.findMany({
      where: { locationId: location.id, ...salonShopWhere },
      include: { catalogProduct: { include: { photo: { select: { id: true } } } } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return {
      currency: location.currency,
      fulfillment: location.shopFulfillment.filter((f) => f === 'pickup_at_salon'),
      products: products
        .sort(
          (a, b) =>
            Number(available(b.stockQuantity)) - Number(available(a.stockQuantity)) ||
            a.name.localeCompare(b.name) ||
            a.id.localeCompare(b.id),
        )
        .map((p) => ({
          id: p.id,
          name: p.name,
          brand: p.catalogProduct?.brand ?? null,
          priceGrosze: p.priceGrosze,
          available: available(p.stockQuantity),
          catalogProductId: p.catalogProductId,
          category: p.catalogProduct?.category ?? null,
          description: p.catalogProduct?.description ?? null,
          photoId: p.catalogProduct?.photo?.id ?? null,
        })),
    };
  }

  /** The "Sklep" tab: every card at least one salon sells online, with all its offers. */
  async list(query: PublicShopQuery): Promise<PublicShopListResponse> {
    const offerWhere: Prisma.ProductWhereInput = query.city
      ? {
          ...marketplaceWhere,
          location: {
            onlineBookingEnabled: true,
            city: { equals: query.city, mode: 'insensitive' },
          },
        }
      : marketplaceWhere;
    // A card is listed while someone has it: the salon counts no pieces, or has some left.
    const inStock: Prisma.ProductWhereInput = {
      ...offerWhere,
      OR: [{ stockQuantity: null }, { stockQuantity: { gt: 0 } }],
    };
    const where: Prisma.CatalogProductWhereInput = {
      offers: { some: inStock },
      ...(query.category ? { category: query.category } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: 'insensitive' } },
              { brand: { contains: query.q, mode: 'insensitive' } },
              ...(/^\d{8,14}$/.test(query.q.replace(/[\s-]+/g, ''))
                ? [{ ean: query.q.replace(/[\s-]+/g, '') }]
                : []),
            ],
          }
        : {}),
    };
    const [total, cards] = await this.prisma.$transaction([
      this.prisma.catalogProduct.count({ where }),
      this.prisma.catalogProduct.findMany({
        where,
        include: this.publicInclude(offerWhere),
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      products: cards.map((c) => this.toPublicProduct(c)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** One card of the "Sklep" tab; 404 unless some salon sells it online. */
  async product(cardId: string): Promise<PublicShopProductResponse> {
    const card = await this.prisma.catalogProduct.findFirst({
      where: { id: cardId, offers: { some: marketplaceWhere } },
      include: this.publicInclude(marketplaceWhere),
    });
    if (!card) throw notFound('Product');
    return this.toPublicProduct(card);
  }

  private publicInclude(offerWhere: Prisma.ProductWhereInput) {
    return {
      photo: { select: { id: true } },
      offers: {
        where: offerWhere,
        include: {
          location: {
            select: {
              slug: true,
              name: true,
              city: true,
              addressLine: true,
              currency: true,
              shopFulfillment: true,
            },
          },
        },
      },
    } satisfies Prisma.CatalogProductInclude;
  }

  private toPublicProduct(card: CardWithPhoto & { offers: OfferRow[] }): PublicShopProductResponse {
    const offers = [...card.offers].sort(byOffer);
    const priced = offers.filter((o) => available(o.stockQuantity));
    const prices = (priced.length > 0 ? priced : offers).map((o) => o.priceGrosze);
    return {
      ...toCard(card),
      fromPriceGrosze: prices.length > 0 ? Math.min(...prices) : 0,
      offers: offers.map(toOffer),
    };
  }
}
