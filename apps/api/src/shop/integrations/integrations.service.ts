import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/app-exception';
import type { MembershipContext } from '../../common/request-context';
import type {
  Prisma,
  ShopIntegration,
  ShopSyncRun,
  ShopSyncTrigger,
} from '../../generated/prisma/client';
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
  BaseOrderStatusesResponse,
  BaseProductsQuery,
  BaseProductsResponse,
  BaseSyncRunResponse,
  BaseSyncRunsResponse,
  ConfigureBaseInput,
  ConfigureBaseOrdersInput,
  ConnectBaseInput,
  ImportBaseInput,
} from './integrations.schemas';
import { BaseOrdersService } from './base-orders.service';
import { SecretBox } from './secret-box';
import { closeRun } from './sync-runs';
import { attachImportedPhotos, type CardPicture } from './product-photos';
import { cut, normalEan, plainText, stockMoved, upsertSellerProduct } from './seller-products';

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

/** "Synchronizuj teraz" again within a minute: Base allows only so many calls per token. */
const tooSoon = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'BASE_SYNC_TOO_SOON',
    'The last renewal started less than a minute ago',
  );

/** Base pages read in one renewal at most (1000 products each). */
const MAX_SYNC_PAGES = 30;

const toRun = (r: ShopSyncRun): BaseSyncRunResponse => ({
  id: r.id,
  trigger: r.trigger,
  startedAt: r.startedAt.toISOString(),
  finishedAt: r.finishedAt?.toISOString() ?? null,
  checked: r.checked,
  changed: r.changed,
  missing: r.missing,
  errorCode: r.errorCode,
  errorMessage: r.errorMessage,
});

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

/**
 * Pieces of each product (by `externalRef`) that Base already took off its own stock for our
 * orders still open there (task Q4 part 5: a product put aside for a visit becomes an order in
 * Base, and Base lowers its stock at once). Our stock counts the pieces physically in the salon,
 * including those put aside, and clients see `stock − put aside`; so these pieces are added back
 * to the stock read from Base — otherwise they would be taken off twice until the visit.
 */
async function inOpenBaseOrders(
  prisma: PrismaService,
  locationId: string,
  prefix: string,
): Promise<Map<string, number>> {
  const rows = await prisma.productReservation.findMany({
    where: {
      // Still waiting here too: a piece handed over is already off our stock (the sale).
      status: 'reserved',
      baseOrderId: { not: null },
      baseOrderState: 'reserved',
      product: { locationId, externalRef: { startsWith: prefix } },
    },
    select: { quantity: true, product: { select: { externalRef: true } } },
  });
  const pieces = new Map<string, number>();
  for (const r of rows) {
    const ref = r.product?.externalRef;
    if (ref) pieces.set(ref, (pieces.get(ref) ?? 0) + r.quantity);
  }
  return pieces;
}

/** Stock read from Base plus the pieces of our open orders in it (see `inOpenBaseOrders`). */
const withOpenOrders = (stock: number | null, inOrders = 0): number | null =>
  stock === null ? null : Math.min(100_000, stock + inOrders);

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
 * Owners and managers only. Part 2: regular renewal of prices and stock, "Synchronizuj teraz", the log.
 * Part 5: products put aside for a visit go back to Base as orders (BaseOrdersService).
 */
@Injectable()
export class ShopIntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LocationAccessService,
    private readonly base: BaseApi,
    private readonly box: SecretBox,
    private readonly orders: BaseOrdersService,
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
      data: {
        inventoryId: input.inventoryId,
        priceGroupId: input.priceGroupId,
        warehouseId: input.warehouseId,
        inventoryName: inventory.name,
        ...(input.syncEveryMinutes ? { syncEveryMinutes: input.syncEveryMinutes } : {}),
      },
    });
    return this.toStatus(locationId, integration);
  }

  /** Task Q4 (part 5): the order statuses of the seller's Base. */
  async orderStatuses(
    m: MembershipContext,
    locationId: string,
  ): Promise<BaseOrderStatusesResponse> {
    await this.access.writable(m, locationId);
    const token = this.token(await this.find(locationId));
    return { statuses: await this.base.orderStatuses(token) };
  }

  /**
   * Task Q4 (part 5): "Zamówienia do Base" on or off, with the statuses of new, handed-over and
   * cancelled orders (each must be a status of this Base). Products put aside before stay as
   * they are until the next round sends the waiting ones.
   */
  async configureOrders(
    m: MembershipContext,
    locationId: string,
    input: ConfigureBaseOrdersInput,
  ): Promise<BaseIntegrationResponse> {
    await this.access.writable(m, locationId);
    const integration = this.configured(await this.find(locationId));
    const chosen = {
      newStatusId: input.newStatusId,
      handedStatusId: input.handedStatusId,
      cancelledStatusId: input.cancelledStatusId,
    };
    if (Object.values(chosen).some((id) => id !== null)) {
      const known = new Set(
        (await this.base.orderStatuses(this.token(integration))).map((st) => st.id),
      );
      for (const [path, id] of Object.entries(chosen)) {
        if (id !== null && !known.has(id)) {
          throw invalidChoice(path, 'No such order status in this Base');
        }
      }
    }
    const updated = await this.prisma.shopIntegration.update({
      where: { id: integration.id },
      data: {
        ordersEnabled: input.enabled,
        orderStatusNewId: chosen.newStatusId,
        orderStatusHandedId: chosen.handedStatusId,
        orderStatusCancelledId: chosen.cancelledStatusId,
      },
    });
    return this.toStatus(locationId, updated);
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
    const run = await this.prisma.shopSyncRun.create({
      data: { integrationId: integration.id, trigger: 'import', checked: input.items.length },
    });
    try {
      const result = await this.importItems(userId, locationId, integration, input);
      await this.finish(run.id, {
        changed: result.created + result.updated,
        missing: result.skipped.filter((s) => s.reason === 'NOT_IN_BASE').length,
      });
      return result;
    } catch (error: unknown) {
      await this.finish(run.id, {}, error);
      throw error;
    }
  }

  private async importItems(
    userId: string,
    locationId: string,
    integration: Configured,
    input: ImportBaseInput,
  ): Promise<BaseImportResultResponse> {
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

    const inOrders = await inOpenBaseOrders(
      this.prisma,
      locationId,
      `base:${integration.inventoryId}:`,
    );

    const result: BaseImportResultResponse = {
      created: 0,
      updated: 0,
      cardsCreated: 0,
      cardsMatched: 0,
      photosAdded: 0,
      skipped: [],
    };
    const pictures: CardPicture[] = [];
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
      const externalRef = baseRef(integration.inventoryId, product.id);
      const outcome = await upsertSellerProduct(this.prisma, userId, locationId, {
        externalRef,
        name,
        brand: product.manufacturerId
          ? cut(makers.get(product.manufacturerId) ?? '', 60) || null
          : null,
        ean: normalEan(product.ean),
        description: plainText(product.description, 2000),
        priceGrosze,
        stockQuantity: withOpenOrders(
          toStock(product.stock, integration.warehouseId),
          inOrders.get(externalRef),
        ),
        online: item.online,
        source: 'Base',
      });
      result[outcome.product] += 1;
      if (outcome.card === 'created') result.cardsCreated += 1;
      if (outcome.card === 'matched') result.cardsMatched += 1;
      pictures.push({
        catalogProductId: outcome.catalogProductId,
        imageUrl: product.imageUrls[0] ?? null,
      });
    }
    result.photosAdded = await attachImportedPhotos(this.prisma, locationId, pictures);
    await this.prisma.shopIntegration.update({
      where: { id: integration.id },
      data: { lastImportAt: new Date() },
    });
    return result;
  }

  /** "Synchronizuj teraz": renews prices and stock of the imported products right away. */
  async syncNow(
    m: MembershipContext,
    userId: string,
    locationId: string,
  ): Promise<BaseSyncRunResponse> {
    await this.access.writable(m, locationId);
    const integration = this.configured(await this.find(locationId));
    if (integration.lastSyncAt && Date.now() - integration.lastSyncAt.getTime() < 60_000) {
      throw tooSoon();
    }
    // Orders to Base first (so its stock already counts them), giving failed ones another go.
    await this.orders.retryFailed(locationId);
    await this.orders.push(integration);
    return toRun(await this.sync(integration, 'manual', userId));
  }

  /** "Dziennik synchronizacji": the latest imports and renewals, newest first. */
  async runs(m: MembershipContext, locationId: string): Promise<BaseSyncRunsResponse> {
    await this.access.writable(m, locationId);
    const integration = await this.find(locationId);
    if (!integration) return { runs: [] };
    const runs = await this.prisma.shopSyncRun.findMany({
      where: { integrationId: integration.id },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: 20,
    });
    return { runs: runs.map(toRun) };
  }

  /**
   * The regular renewal (ShopSyncScheduler): every configured integration whose last renewal is
   * older than its `syncEveryMinutes` and that has imported products. Returns how many ran.
   */
  async syncDue(now = new Date()): Promise<number> {
    const candidates = await this.prisma.shopIntegration.findMany({
      where: {
        provider: 'base',
        inventoryId: { not: null },
        priceGroupId: { not: null },
        warehouseId: { not: null },
      },
    });
    let ran = 0;
    for (const integration of candidates) {
      const due =
        !integration.lastSyncAt ||
        now.getTime() - integration.lastSyncAt.getTime() >= integration.syncEveryMinutes * 60_000;
      if (!due) continue;
      const imported = await this.prisma.product.count({
        where: {
          locationId: integration.locationId,
          externalRef: { startsWith: `base:${integration.inventoryId}:` },
        },
      });
      if (imported === 0) continue;
      await this.sync(this.configured(integration), 'schedule', null, now);
      ran += 1;
    }
    return ran;
  }

  /**
   * Renews price (from the chosen price group) and stock (from the chosen warehouse) of every
   * product imported from the chosen catalogue. A product gone from the catalogue gets stock 0
   * (clients see it as not available); its other data stays. Errors go to the log, not out.
   */
  private async sync(
    integration: Configured,
    trigger: ShopSyncTrigger,
    userId: string | null,
    now = new Date(),
  ): Promise<ShopSyncRun> {
    const run = await this.prisma.shopSyncRun.create({
      data: { integrationId: integration.id, trigger, startedAt: now },
    });
    await this.prisma.shopIntegration.update({
      where: { id: integration.id },
      data: { lastSyncAt: now },
    });
    const prefix = `base:${integration.inventoryId}:`;
    let checked = 0;
    let changed = 0;
    let missing = 0;
    try {
      const token = this.token(integration);
      const products = await this.prisma.product.findMany({
        where: { locationId: integration.locationId, externalRef: { startsWith: prefix } },
        select: { id: true, externalRef: true, priceGrosze: true, stockQuantity: true },
      });
      const inOrders = await inOpenBaseOrders(this.prisma, integration.locationId, prefix);
      const inBase = new Map<string, BaseListedProduct>();
      if (products.length > 0) {
        for (let page = 1; page <= MAX_SYNC_PAGES; page += 1) {
          const listed = await this.base.listProducts(token, integration.inventoryId, page);
          for (const p of listed) inBase.set(p.id, p);
          if (listed.length < BASE_PAGE_SIZE) break;
        }
      }
      for (const product of products) {
        checked += 1;
        const found = inBase.get(product.externalRef?.slice(prefix.length) ?? '');
        const price = found ? toGrosze(found.prices[integration.priceGroupId]) : null;
        const stock = found
          ? withOpenOrders(
              toStock(found.stock, integration.warehouseId),
              inOrders.get(product.externalRef ?? ''),
            )
          : 0;
        if (!found) missing += 1;
        const data: Prisma.ProductUpdateInput = {};
        if (price !== null && price !== product.priceGrosze) data.priceGrosze = price;
        if (stock !== product.stockQuantity) data.stockQuantity = stock;
        if (Object.keys(data).length === 0) continue;
        await this.prisma.$transaction(async (tx) => {
          await tx.product.update({ where: { id: product.id }, data });
          if (data.stockQuantity !== undefined) {
            await stockMoved(tx, product.id, product.stockQuantity, stock, userId, 'Base');
          }
        });
        changed += 1;
      }
      return await this.finish(run.id, { checked, changed, missing });
    } catch (error: unknown) {
      return this.finish(run.id, { checked, changed, missing }, error);
    }
  }

  private finish(
    runId: string,
    counts: { checked?: number; changed?: number; missing?: number },
    error?: unknown,
  ): Promise<ShopSyncRun> {
    return closeRun(this.prisma, runId, counts, error);
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
    const [importedProducts, lastRun, failing] = await Promise.all([
      this.prisma.product.count({ where: { locationId, externalRef: { startsWith: 'base:' } } }),
      integration
        ? this.prisma.shopSyncRun.findFirst({
            where: { integrationId: integration.id, finishedAt: { not: null } },
            orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
            select: { errorCode: true },
          })
        : null,
      integration ? this.orders.failing(locationId) : 0,
    ]);
    return {
      connected: integration !== null,
      tokenHint: integration?.tokenHint ?? null,
      tokenReadable: integration ? this.box.open(integration.tokenCiphertext) !== null : false,
      inventoryId: integration?.inventoryId ?? null,
      inventoryName: integration?.inventoryName ?? null,
      priceGroupId: integration?.priceGroupId ?? null,
      warehouseId: integration?.warehouseId ?? null,
      lastImportAt: integration?.lastImportAt?.toISOString() ?? null,
      syncEveryMinutes: integration?.syncEveryMinutes ?? 60,
      lastSyncAt: integration?.lastSyncAt?.toISOString() ?? null,
      lastErrorCode: lastRun?.errorCode ?? null,
      importedProducts,
      orders: {
        enabled: integration?.ordersEnabled ?? false,
        newStatusId: integration?.orderStatusNewId ?? null,
        handedStatusId: integration?.orderStatusHandedId ?? null,
        cancelledStatusId: integration?.orderStatusCancelledId ?? null,
        failing,
      },
    };
  }
}
