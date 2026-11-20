import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AppException } from '../../common/app-exception';
import { APP_CONFIG, type AppConfig } from '../../config/config';

/** How long one call to Base may take before the seller sees "Base nie odpowiada". */
const TIMEOUT_MS = 20_000;

/** Task 606: how many pages of 100 orders `findOrder` reads looking for an order made before. */
const FIND_ORDER_PAGES = 5;

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

/** A status of orders in the seller's Base ("Nowe", "Do odbioru", "Anulowane", …). */
export interface BaseOrderStatus {
  id: string;
  name: string;
}

/** Task Q4 (part 5): one order made for a product put aside for a visit. */
export interface BaseNewOrder {
  statusId: string;
  currency: string;
  /** Who picks it up — the salon's client. */
  fullName: string;
  email: string | null;
  phone: string | null;
  /** Shown to the seller in Base: "Odbiór przy wizycie 21.11 14:00 · …". */
  comment: string;
  /** Our reservation id, so the seller (and we) can find the order. */
  reference: string;
  product: {
    productId: string;
    name: string;
    ean: string | null;
    /** Units of the currency, e.g. 69.99. */
    price: number;
    quantity: number;
    /** "bl_201" → 201: the stock is taken from this warehouse in Base. */
    warehouseId: string;
  };
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
 * part 1: catalogues, price groups, warehouses, products and makers; part 5 adds orders. Base allows about 100
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

  /** Task Q4 (part 5): the order statuses of the seller's Base. */
  async orderStatuses(token: string): Promise<BaseOrderStatus[]> {
    const body = await this.call(token, 'getOrderStatusList', {});
    return records(body.statuses).map((st) => ({
      id: str(st.id) ?? '',
      name: str(st.name) ?? str(st.name_for_customer) ?? '',
    }));
  }

  /**
   * Task Q4 (part 5): an order "odbiór w salonie, płatność na miejscu" for one product of the
   * seller's catalogue (storage "db" = the Base catalogue). Returns the order id in Base.
   */
  async addOrder(token: string, order: BaseNewOrder): Promise<string> {
    const warehouse = Number(order.product.warehouseId.replace(/^[a-z]+_/, ''));
    const body = await this.call(token, 'addOrder', {
      order_status_id: Number(order.statusId),
      date_add: Math.floor(Date.now() / 1000),
      currency: order.currency.toUpperCase(),
      payment_method: 'Płatność w salonie',
      payment_method_cod: false,
      paid: false,
      user_comments: '',
      admin_comments: order.comment.slice(0, 500),
      email: order.email ?? '',
      phone: order.phone ?? '',
      user_login: '',
      delivery_method: 'Odbiór w salonie',
      delivery_price: 0,
      delivery_fullname: order.fullName.slice(0, 100),
      delivery_company: '',
      delivery_address: '',
      delivery_city: '',
      delivery_postcode: '',
      delivery_country_code: '',
      want_invoice: false,
      extra_field_1: order.reference,
      products: [
        {
          storage: 'db',
          storage_id: 0,
          product_id: order.product.productId,
          variant_id: 0,
          name: order.product.name,
          sku: '',
          ean: order.product.ean ?? '',
          ...(Number.isFinite(warehouse) && warehouse > 0 ? { warehouse_id: warehouse } : {}),
          price_brutto: order.product.price,
          // Base needs a rate; 23 % is the usual VAT on cosmetics in Poland. The seller's own
          // settings in Base (invoices) decide the rest.
          tax_rate: 23,
          quantity: order.product.quantity,
          weight: 0,
        },
      ],
    });
    const id = str(body.order_id);
    if (!id) throw baseError('no order_id in the answer to addOrder');
    return id;
  }

  /**
   * Task 606: the order made for a reservation earlier (its id is in `extra_field_1`), when a
   * previous addOrder may have reached Base but its answer did not reach us (a timeout, a crash).
   * Reads the orders added since `since` (unconfirmed ones too, up to a few pages of 100) and
   * returns the id of the one with this reference, or null when Base has none.
   */
  async findOrder(
    token: string,
    reference: string,
    since: Date,
    email: string | null,
  ): Promise<string | null> {
    let idFrom = 0;
    for (let page = 0; page < FIND_ORDER_PAGES; page += 1) {
      const body = await this.call(token, 'getOrders', {
        date_from: Math.floor(since.getTime() / 1000),
        id_from: idFrom,
        get_unconfirmed_orders: true,
        ...(email ? { filter_email: email } : {}),
      });
      const orders = records(body.orders);
      for (const order of orders) {
        const id = str(order.order_id);
        if (id && str(order.extra_field_1) === reference) return id;
      }
      if (orders.length < 100) return null;
      const last = Math.max(...orders.map((o) => num(o.order_id) ?? 0));
      if (!(last > idFrom)) return null;
      idFrom = last + 1;
    }
    return null;
  }

  /** Task Q4 (part 5): moves an order to another status (handed over, cancelled). */
  async setOrderStatus(token: string, orderId: string, statusId: string): Promise<void> {
    await this.call(token, 'setOrderStatus', {
      order_id: Number(orderId),
      status_id: Number(statusId),
    });
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
