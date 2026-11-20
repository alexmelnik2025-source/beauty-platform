import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/app-exception';
import type { MembershipContext } from '../../common/request-context';
import type { Prisma, ShopIntegration } from '../../generated/prisma/client';
import { LocationAccessService } from '../../organizations/location-access.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BASE_DATA_BATCH,
  BASE_PAGE_SIZE,
  BaseApi,
  type BaseListedProduct,
  type BaseProductData,
} from './base-api';
import type {
  BaseImportResultResponse,
  BaseIntegrationResponse,
  BaseOptionsResponse,
  BaseProductsQuery,
  BaseProductsResponse,
  ConfigureBaseInput,
  ConnectBaseInput,
  ImportBaseInput,
} from './integrations.schemas';
import { SecretBox } from './secret-box';

const notConnected = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'BASE_NOT_CONNECTED',
    'Connect Base with its API token first',
  );

const notConfigured = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'BASE_NOT_CONFIGURED',
    'Choose the catalogue, price group and warehouse first',
  );

/** The stored token cannot be read with the server's key any more: paste it again. */
const reconnect = (): AppException =>
  new AppException(HttpStatus.CONFLICT, 'BASE_RECONNECT', 'Paste the Base API token again');

const invalidChoice = (path: string, message: string): AppException =>
  new AppException(HttpStatus.UNPROCESSABLE_ENTITY, 'BASE_INVALID_CHOICE', message, [
    { path, message },
  ]);

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';

/** The code on the package as the catalogue keeps it (digits of EAN-8/UPC/EAN-13/GTIN-14). */
const normalEan = (value: string | null): string | null => {
  const digits = value?.replace(/[\s-]+/g, '') ?? '';
  return /^\d{8}$|^\d{12,14}$/.test(digits) ? digits : null;
};

/** Base keeps descriptions as HTML; the catalogue keeps plain text. */
const plainText = (html: string | null, max: number): string | null => {
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

const cut = (value: string, max: number) => value.trim().slice(0, max).trim();

/** Where a product came from in Base: one catalogue, one product id. */
const baseRef = (inventoryId: string, productId: string) => `base:${inventoryId}:${productId}`;

/** Prices in Base are in units of the currency (49.99); the platform counts hundredths. */
const toGrosze = (price: number | undefined): number | null =>
  price === undefined || price < 0 ? null : Math.round(price * 100);

/** Stock in the chosen warehouse; null = the product is not kept there (the salon does not count). */
const toStock = (stock: Record<string, number>, warehouseId: string): number | null => {
  const value = stock[warehouseId];
  return value === undefined ? null : Math.min(100_000, Math.max(0, Math.floor(value)));
};

type Configured = ShopIntegration & {
  inventoryId: string;
  priceGroupId: string;
  warehouseId: string;
};

/**
 * Task Q4 (part 1): "Mój sklep" → "Integracje" → "Base (BaseLinker)". The seller pastes its own
 * API token (stored encrypted), chooses one catalogue, price group and warehouse, and ticks the
 * products to import: each becomes the salon's product (its price and stock from Base) joined to
 * the platform card with the same EAN, or to a new card. Nothing is published by itself — only
 * the ticked products, "tylko w salonie" or "też online w Sklepie".
 *
 * Owners and managers only. Later parts: regular price/stock sync, orders back to Base, a log.
 */
@Injectable()
export class ShopIntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LocationAccessService,
    private readonly base: BaseApi,
    private readonly box: SecretBox,
  ) {}

  async status(m: MembershipContext, locationId: string): Promise<BaseIntegrationResponse> {
    await this.access.writable(m, locationId);
    return this.toStatus(locationId, await this.find(locationId));
  }

  /** Step 1: Base must accept the token (it lists the seller's catalogues) before it is kept. */
  async connect(
    m: MembershipContext,
    userId: string,
    locationId: string,
    input: ConnectBaseInput,
  ): Promise<BaseIntegrationResponse> {
    await this.access.writable(m, locationId);
    await this.base.inventories(input.token);
    const sealed = this.box.seal(input.token);
    const hint = input.token.slice(-4);
    const integration = await this.prisma.shopIntegration.upsert({
      where: { locationId_provider: { locationId, provider: 'base' } },
      create: {
        locationId,
        provider: 'base',
        tokenCiphertext: sealed,
        tokenHint: hint,
        createdByUserId: userId,
      },
      update: { tokenCiphertext: sealed, tokenHint: hint },
    });
    return this.toStatus(locationId, integration);
  }

  /** "Odłącz": the token is forgotten; imported products stay as the salon's own. */
  async disconnect(m: MembershipContext, locationId: string): Promise<BaseIntegrationResponse> {
    await this.access.writable(m, locationId);
    await this.prisma.shopIntegration.deleteMany({ where: { locationId, provider: 'base' } });
    return this.toStatus(locationId, null);
  }

  /** Step 2: catalogues, price groups and warehouses of the seller's Base. */
  async options(m: MembershipContext, locationId: string): Promise<BaseOptionsResponse> {
    const location = await this.access.writable(m, locationId);
    const token = this.token(await this.find(locationId));
    const [inventories, priceGroups, warehouses] = await Promise.all([
      this.base.inventories(token),
      this.base.priceGroups(token),
      this.base.warehouses(token),
    ]);
    return {
      inventories,
      priceGroups: priceGroups.map((g) => ({
        ...g,
        matchesSalon: g.currency === location.currency.toUpperCase(),
      })),
      warehouses,
    };
  }

  async configure(
    m: MembershipContext,
    locationId: string,
    input: ConfigureBaseInput,
  ): Promise<BaseIntegrationResponse> {
    const options = await this.options(m, locationId);
    const inventory = options.inventories.find((i) => i.id === input.inventoryId);
    if (!inventory) throw invalidChoice('inventoryId', 'No such catalogue in this Base');
    const group = options.priceGroups.find((g) => g.id === input.priceGroupId);
    if (
      !group ||
      (inventory.priceGroupIds.length > 0 && !inventory.priceGroupIds.includes(group.id))
    ) {
      throw invalidChoice('priceGroupId', 'This price group is not in the chosen catalogue');
    }
    if (!group.matchesSalon) {
      throw invalidChoice('priceGroupId', 'The price group is in another currency than the salon');
    }
    if (
      !options.warehouses.some((w) => w.id === input.warehouseId) ||
      (inventory.warehouseIds.length > 0 && !inventory.warehouseIds.includes(input.warehouseId))
    ) {
      throw invalidChoice('warehouseId', 'This warehouse is not in the chosen catalogue');
    }
    const integration = await this.prisma.shopIntegration.update({
      where: { locationId_provider: { locationId, provider: 'base' } },
      data: { ...input, inventoryName: inventory.name },
    });
    return this.toStatus(locationId, integration);
  }

  /** Step 3a: one page of the seller's catalogue, with what the platform already has of it. */
  async products(
    m: MembershipContext,
    locationId: string,
    query: BaseProductsQuery,
  ): Promise<BaseProductsResponse> {
    await this.access.writable(m, locationId);
    const integration = this.configured(await this.find(locationId));
    const listed = await this.base.listProducts(
      this.token(integration),
      integration.inventoryId,
      query.page,
    );
    const refs = listed.map((p) => baseRef(integration.inventoryId, p.id));
    const eans = [...new Set(listed.map((p) => normalEan(p.ean)).filter((e) => e !== null))];
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
      page: query.page,
      hasMore: listed.length >= BASE_PAGE_SIZE,
      products: listed.map((p: BaseListedProduct) => {
        const mine = byRef.get(baseRef(integration.inventoryId, p.id));
        const ean = normalEan(p.ean);
        return {
          externalId: p.id,
          name: p.name,
          ean,
          sku: p.sku,
          priceGrosze: toGrosze(p.prices[integration.priceGroupId]),
          stock: toStock(p.stock, integration.warehouseId),
          importedProductId: mine?.id ?? null,
          catalogProductId: mine?.catalogProductId ?? (ean ? (cardByEan.get(ean) ?? null) : null),
        };
      }),
    };
  }

  /** Step 3b: the ticked products become (or renew) the salon's products. */
  async import(
    m: MembershipContext,
    userId: string,
    locationId: string,
    input: ImportBaseInput,
  ): Promise<BaseImportResultResponse> {
    await this.access.writable(m, locationId);
    const integration = this.configured(await this.find(locationId));
    const token = this.token(integration);
    const ids = input.items.map((i) => i.externalId);
    const data: BaseProductData[] = [];
    for (let i = 0; i < ids.length; i += BASE_DATA_BATCH) {
      data.push(
        ...(await this.base.productsData(
          token,
          integration.inventoryId,
          ids.slice(i, i + BASE_DATA_BATCH),
        )),
      );
    }
    const byId = new Map(data.map((d) => [d.id, d]));
    const makers = data.some((d) => d.manufacturerId)
      ? await this.base.manufacturers(token)
      : new Map<string, string>();

    const result: BaseImportResultResponse = {
      created: 0,
      updated: 0,
      cardsCreated: 0,
      cardsMatched: 0,
      skipped: [],
    };
    for (const item of input.items) {
      const product = byId.get(item.externalId);
      if (!product) {
        result.skipped.push({ externalId: item.externalId, reason: 'NOT_IN_BASE' });
        continue;
      }
      const priceGrosze = toGrosze(product.prices[integration.priceGroupId]);
      if (priceGrosze === null) {
        result.skipped.push({ externalId: item.externalId, reason: 'NO_PRICE' });
        continue;
      }
      const name = cut(product.name, 120);
      if (!name) {
        result.skipped.push({ externalId: item.externalId, reason: 'NO_NAME' });
        continue;
      }
      const outcome = await this.importOne(userId, locationId, integration, {
        externalRef: baseRef(integration.inventoryId, product.id),
        name,
        brand: product.manufacturerId
          ? cut(makers.get(product.manufacturerId) ?? '', 60) || null
          : null,
        ean: normalEan(product.ean),
        description: plainText(product.description, 2000),
        priceGrosze,
        stockQuantity: toStock(product.stock, integration.warehouseId),
        online: item.online,
      });
      result[outcome.product] += 1;
      if (outcome.card === 'created') result.cardsCreated += 1;
      if (outcome.card === 'matched') result.cardsMatched += 1;
    }
    await this.prisma.shopIntegration.update({
      where: { id: integration.id },
      data: { lastImportAt: new Date() },
    });
    return result;
  }

  private async importOne(
    userId: string,
    locationId: string,
    integration: Configured,
    p: {
      externalRef: string;
      name: string;
      brand: string | null;
      ean: string | null;
      description: string | null;
      priceGrosze: number;
      stockQuantity: number | null;
      online: boolean;
    },
    attempt = 0,
  ): Promise<{ product: 'created' | 'updated'; card: 'created' | 'matched' | 'kept' }> {
    return this.prisma
      .$transaction(async (tx) => {
        // The same Base product imported before, or the salon's own product with the same code.
        const existing =
          (await tx.product.findFirst({ where: { locationId, externalRef: p.externalRef } })) ??
          (p.ean
            ? await tx.product.findFirst({
                where: { locationId, barcode: p.ean, externalRef: null },
              })
            : null);
        // Another Base product of this salon already carries the code: this one goes without it.
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
            await this.stockMoved(tx, existing.id, existing.stockQuantity, p.stockQuantity, userId);
          }
          return { product: 'updated' as const, card };
        }
        const created = await tx.product.create({ data: { ...data, locationId } });
        if (p.stockQuantity !== null && p.stockQuantity > 0) {
          await this.stockMoved(tx, created.id, null, p.stockQuantity, userId);
        }
        return { product: 'created' as const, card };
      })
      .catch(async (error: unknown) => {
        // Another import made the same card or product a moment ago: once more finds it.
        if (isUniqueViolation(error) && attempt === 0) {
          return this.importOne(userId, locationId, integration, p, 1);
        }
        throw error;
      });
  }

  /** The pieces Base reports, written down as a correction "from Base" (task 440's history). */
  private stockMoved(
    tx: Prisma.TransactionClient,
    productId: string,
    before: number | null,
    after: number | null,
    userId: string,
  ) {
    return tx.stockMovement.create({
      data: {
        productId,
        kind: 'correction',
        change: (after ?? 0) - (before ?? 0),
        quantityAfter: after,
        createdByUserId: userId,
        note: 'Base',
      },
    });
  }

  private find(locationId: string): Promise<ShopIntegration | null> {
    return this.prisma.shopIntegration.findUnique({
      where: { locationId_provider: { locationId, provider: 'base' } },
    });
  }

  private token(integration: ShopIntegration | null): string {
    if (!integration) throw notConnected();
    const token = this.box.open(integration.tokenCiphertext);
    if (!token) throw reconnect();
    return token;
  }

  private configured(integration: ShopIntegration | null): Configured {
    if (!integration) throw notConnected();
    const { inventoryId, priceGroupId, warehouseId } = integration;
    if (!inventoryId || !priceGroupId || !warehouseId) throw notConfigured();
    return { ...integration, inventoryId, priceGroupId, warehouseId };
  }

  private async toStatus(
    locationId: string,
    integration: ShopIntegration | null,
  ): Promise<BaseIntegrationResponse> {
    const importedProducts = await this.prisma.product.count({
      where: { locationId, externalRef: { startsWith: 'base:' } },
    });
    return {
      connected: integration !== null,
      tokenHint: integration?.tokenHint ?? null,
      tokenReadable: integration ? this.box.open(integration.tokenCiphertext) !== null : false,
      inventoryId: integration?.inventoryId ?? null,
      inventoryName: integration?.inventoryName ?? null,
      priceGroupId: integration?.priceGroupId ?? null,
      warehouseId: integration?.warehouseId ?? null,
      lastImportAt: integration?.lastImportAt?.toISOString() ?? null,
      importedProducts,
    };
  }
}
