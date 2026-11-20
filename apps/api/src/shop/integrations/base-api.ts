import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AppException } from '../../common/app-exception';
import { APP_CONFIG, type AppConfig } from '../../config/config';

/** How long one call to Base may take before the seller sees "Base nie odpowiada". */
const TIMEOUT_MS = 20_000;

/** Base answers at most 1000 products per page of getInventoryProductsList. */
export const BASE_PAGE_SIZE = 1000;

/** getInventoryProductsData takes this many ids at once (kept below Base's own limit). */
export const BASE_DATA_BATCH = 100;

export interface BaseInventory {
  id: string;
  name: string;
  priceGroupIds: string[];
  defaultPriceGroupId: string | null;
  warehouseIds: string[];
  defaultWarehouseId: string | null;
}

export interface BasePriceGroup {
  id: string;
  name: string;
  currency: string;
}

export interface BaseWarehouse {
  /** As Base writes it in stock lists: "<type>_<id>", e.g. "bl_123". */
  id: string;
  name: string;
}

/** One row of the seller's catalogue list (a quick look: no description, no maker). */
export interface BaseListedProduct {
  id: string;
  name: string;
  ean: string | null;
  sku: string | null;
  prices: Record<string, number>;
  stock: Record<string, number>;
}

/** One product with everything the import needs. */
export interface BaseProductData extends BaseListedProduct {
  description: string | null;
  manufacturerId: string | null;
  imageUrls: string[];
}

/** The token was refused by Base: wrong, removed or the account is blocked. */
export const baseTokenInvalid = (): AppException =>
  new AppException(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'BASE_TOKEN_INVALID',
    'Base did not accept this API token',
  );

/** Base answered with an error of its own (the seller sees it as written). */
const baseError = (message: string): AppException =>
  new AppException(HttpStatus.BAD_GATEWAY, 'BASE_ERROR', `Base: ${message}`.slice(0, 300));

const baseUnreachable = (): AppException =>
  new AppException(HttpStatus.BAD_GATEWAY, 'BASE_UNREACHABLE', 'Base did not answer');

const TOKEN_ERRORS = new Set([
  'ERROR_BAD_TOKEN',
  'ERROR_USER_ACCOUNT_BLOCKED',
  'ERROR_EMPTY_TOKEN',
  'ERROR_BAD_TOKEN_FORMAT',
]);

type Json = Record<string, unknown>;

const str = (value: unknown): string | null => {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const num = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number(value.replace(',', '.')) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** `{ "105": 49.99 }` → numbers only; anything else is left out. */
const numbers = (value: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (value && typeof value === 'object') {
    for (const [key, raw] of Object.entries(value as Json)) {
      const n = num(raw);
      if (n !== null) out[key] = n;
    }
  }
  return out;
};

const records = (value: unknown): Json[] =>
  Array.isArray(value) ? value.filter((v): v is Json => !!v && typeof v === 'object') : [];

/** Base sends products as an object keyed by product id. */
const productMap = (value: unknown): [string, Json][] =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value as Json).filter(
        (entry): entry is [string, Json] => !!entry[1] && typeof entry[1] === 'object',
      )
    : [];

/**
 * Task Q4: the Base (BaseLinker) API, called with the seller's own token. One address, the
 * method and its JSON parameters in a form (see https://api.baselinker.com). Reads only, in
 * this part: catalogues, price groups, warehouses, products and makers. Base allows about 100
 * calls a minute per token; one import of up to a few hundred products makes a handful.
 */
@Injectable()
export class BaseApi {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async inventories(token: string): Promise<BaseInventory[]> {
    const body = await this.call(token, 'getInventories', {});
    return records(body.inventories).map((i) => ({
      id: str(i.inventory_id) ?? '',
      name: str(i.name) ?? '',
      priceGroupIds: Array.isArray(i.price_groups) ? i.price_groups.map(String) : [],
      defaultPriceGroupId: str(i.default_price_group),
      warehouseIds: Array.isArray(i.warehouses) ? i.warehouses.map(String) : [],
      defaultWarehouseId: str(i.default_warehouse),
    }));
  }

  async priceGroups(token: string): Promise<BasePriceGroup[]> {
    const body = await this.call(token, 'getInventoryPriceGroups', {});
    return records(body.price_groups).map((g) => ({
      id: str(g.price_group_id) ?? '',
      name: str(g.name) ?? '',
      currency: (str(g.currency) ?? '').toUpperCase(),
    }));
  }

  async warehouses(token: string): Promise<BaseWarehouse[]> {
    const body = await this.call(token, 'getInventoryWarehouses', {});
    return records(body.warehouses).map((w) => ({
      id: `${str(w.warehouse_type) ?? 'bl'}_${str(w.warehouse_id) ?? ''}`,
      name: str(w.name) ?? '',
    }));
  }

  /** One page (1-based) of the catalogue, at most BASE_PAGE_SIZE products. */
  async listProducts(
    token: string,
    inventoryId: string,
    page: number,
  ): Promise<BaseListedProduct[]> {
    const body = await this.call(token, 'getInventoryProductsList', {
      inventory_id: Number(inventoryId),
      page,
    });
    return productMap(body.products).map(([id, p]) => ({
      id: str(p.id) ?? id,
      name: str(p.name) ?? '',
      ean: str(p.ean),
      sku: str(p.sku),
      prices: numbers(p.prices),
      stock: numbers(p.stock),
    }));
  }

  /** Everything about the given products (at most BASE_DATA_BATCH ids). */
  async productsData(
    token: string,
    inventoryId: string,
    ids: string[],
  ): Promise<BaseProductData[]> {
    const body = await this.call(token, 'getInventoryProductsData', {
      inventory_id: Number(inventoryId),
      products: ids.map(Number),
    });
    return productMap(body.products).map(([id, p]) => {
      const text = (
        p.text_fields && typeof p.text_fields === 'object' ? p.text_fields : {}
      ) as Json;
      const images =
        p.images && typeof p.images === 'object'
          ? Object.values(p.images as Json).filter((u): u is string => typeof u === 'string')
          : [];
      return {
        id,
        name: str(text.name) ?? str(p.name) ?? '',
        ean: str(p.ean),
        sku: str(p.sku),
        prices: numbers(p.prices),
        stock: numbers(p.stock),
        description: str(text.description),
        manufacturerId: p.manufacturer_id ? str(p.manufacturer_id) : null,
        imageUrls: images,
      };
    });
  }

  /** Maker id → name. */
  async manufacturers(token: string): Promise<Map<string, string>> {
    const body = await this.call(token, 'getInventoryManufacturers', {});
    return new Map(
      records(body.manufacturers)
        .map((m) => [str(m.manufacturer_id), str(m.name)] as const)
        .filter((pair): pair is [string, string] => pair[0] !== null && pair[1] !== null),
    );
  }

  private async call(token: string, method: string, parameters: Json): Promise<Json> {
    let response: Response;
    try {
      response = await fetch(this.config.BASE_API_URL, {
        method: 'POST',
        headers: { 'X-BLToken': token, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ method, parameters: JSON.stringify(parameters) }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw baseUnreachable();
    }
    let body: Json;
    try {
      body = (await response.json()) as Json;
    } catch {
      throw baseUnreachable();
    }
    if (body.status === 'SUCCESS') return body;
    const code = str(body.error_code) ?? '';
    if (TOKEN_ERRORS.has(code) || response.status === 401 || response.status === 403) {
      throw baseTokenInvalid();
    }
    throw baseError(str(body.error_message) ?? (code || `HTTP ${response.status}`));
  }
}
