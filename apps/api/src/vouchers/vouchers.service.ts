import { randomBytes } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, notFound } from '../common/app-exception';
import type { MembershipContext } from '../common/request-context';
import type { GiftVoucher, Location } from '../generated/prisma/client';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CsvLocale } from '../reports/visits-csv';
import { instantToLocal, localToday } from '../scheduling/time';
import { vouchersCsv } from './vouchers-csv';
import type {
  CreateGiftVoucherInput,
  GiftVoucherDetailsResponse,
  GiftVoucherListResponse,
  GiftVoucherResponse,
  RedeemGiftVoucherInput,
  UpdateGiftVoucherInput,
} from './vouchers.schemas';

/** Letters and digits that cannot be confused when read aloud or typed (no 0/O, 1/I/L). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export function newVoucherCode(): string {
  let code = '';
  while (code.length < CODE_LENGTH) {
    for (const byte of randomBytes(16)) {
      // 248 = the largest multiple of 31 below 256: every letter equally likely.
      if (byte < 248 && code.length < CODE_LENGTH) code += CODE_ALPHABET[byte % 31];
    }
  }
  return code;
}

const dateValue = (date: string): Date => new Date(`${date}T00:00:00.000Z`);
const dateString = (date: Date): string => date.toISOString().slice(0, 10);

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';

function statusOf(v: GiftVoucher, today: string): GiftVoucherResponse['status'] {
  if (v.cancelledAt) return 'cancelled';
  if (v.balanceGrosze <= 0) return 'used';
  if (v.validUntil && dateString(v.validUntil) < today) return 'expired';
  return 'active';
}

/**
 * Task 490: "Bony podarunkowe" — gift vouchers the salon sells at its own till (no payment
 * systems: the money is taken as for a visit). The client pays with the voucher in parts until
 * nothing is left; every payment is written down with who and when.
 *
 * Owners and managers sell, list and cancel vouchers. Everyone in the salon may look a voucher up
 * by its code and take a payment with it (at the till). A payment is taken in one step, so two at
 * the same moment never use more than is left.
 */
@Injectable()
export class VouchersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LocationAccessService,
  ) {}

  private async names(userIds: (string | null)[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds.filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(users.flatMap((u) => (u.name ? [[u.id, u.name] as const] : [])));
  }

  private toVoucher(
    v: GiftVoucher,
    location: Location,
    names: Map<string, string>,
  ): GiftVoucherResponse {
    const today = localToday(Date.now(), location.timezone);
    return {
      id: v.id,
      code: v.code,
      amountGrosze: v.amountGrosze,
      balanceGrosze: v.balanceGrosze,
      validUntil: v.validUntil ? dateString(v.validUntil) : null,
      recipient: v.recipient,
      note: v.note,
      status: statusOf(v, today),
      soldDate: instantToLocal(v.createdAt.getTime(), location.timezone).date,
      soldByName: (v.createdByUserId && names.get(v.createdByUserId)) || null,
      cancelledAt: v.cancelledAt ? v.cancelledAt.toISOString() : null,
    };
  }

  async list(m: MembershipContext, locationId: string): Promise<GiftVoucherListResponse> {
    const location = await this.access.writable(m, locationId);
    const rows = await this.prisma.giftVoucher.findMany({
      where: { locationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 500,
    });
    const names = await this.names(rows.map((r) => r.createdByUserId));
    const vouchers = rows.map((r) => this.toVoucher(r, location, names));
    const active = await this.prisma.giftVoucher.findMany({
      where: { locationId, cancelledAt: null, balanceGrosze: { gt: 0 } },
      select: { balanceGrosze: true, validUntil: true },
    });
    const today = localToday(Date.now(), location.timezone);
    return {
      vouchers,
      activeBalanceGrosze: active
        .filter((v) => !v.validUntil || dateString(v.validUntil) >= today)
        .reduce((sum, v) => sum + v.balanceGrosze, 0),
    };
  }

  /**
   * Task 494: "CSV bonów" — every voucher of the salon, oldest first, for the accountant (owners
   * and managers).
   */
  async csv(
    m: MembershipContext,
    locationId: string,
    locale: CsvLocale,
  ): Promise<{ csv: string; fileName: string }> {
    const location = await this.access.writable(m, locationId);
    const rows = await this.prisma.giftVoucher.findMany({
      where: { locationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const names = await this.names(rows.map((r) => r.createdByUserId));
    const lines = rows.map((r) => {
      const v = this.toVoucher(r, location, names);
      return {
        code: v.code,
        soldDate: v.soldDate,
        soldBy: v.soldByName ?? '',
        recipient: v.recipient,
        amountGrosze: v.amountGrosze,
        balanceGrosze: v.balanceGrosze,
        validUntil: v.validUntil,
        status: v.status,
        note: v.note,
      };
    });
    const day = instantToLocal(Date.now(), location.timezone).date;
    return { csv: vouchersCsv(lines, locale), fileName: `vouchers-${location.slug}-${day}.csv` };
  }

  async create(
    m: MembershipContext,
    userId: string,
    locationId: string,
    input: CreateGiftVoucherInput,
  ): Promise<GiftVoucherResponse> {
    const location = await this.access.writable(m, locationId);
    if (input.validUntil && input.validUntil < localToday(Date.now(), location.timezone)) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        'VOUCHER_DATE_PAST',
        'The voucher cannot end before today',
      );
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const voucher = await this.prisma.giftVoucher.create({
          data: {
            locationId,
            code: newVoucherCode(),
            amountGrosze: input.amountGrosze,
            balanceGrosze: input.amountGrosze,
            validUntil: input.validUntil ? dateValue(input.validUntil) : null,
            recipient: input.recipient ?? null,
            note: input.note ?? null,
            createdByUserId: userId,
          },
        });
        return this.toVoucher(voucher, location, await this.names([userId]));
      } catch (error) {
        // Two vouchers of the salon with the same code: try another (31^8 codes, very rare).
        if (!isUniqueViolation(error) || attempt >= 4) throw error;
      }
    }
  }

  private async details(
    voucher: GiftVoucher,
    location: Location,
  ): Promise<GiftVoucherDetailsResponse> {
    const uses = await this.prisma.giftVoucherUse.findMany({
      where: { voucherId: voucher.id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const names = await this.names([
      voucher.createdByUserId,
      ...uses.map((u) => u.createdByUserId),
    ]);
    return {
      voucher: this.toVoucher(voucher, location, names),
      uses: uses.map((u) => {
        const local = instantToLocal(u.createdAt.getTime(), location.timezone);
        return {
          id: u.id,
          amountGrosze: u.amountGrosze,
          note: u.note,
          date: local.date,
          time: local.time,
          byName: (u.createdByUserId && names.get(u.createdByUserId)) || null,
        };
      }),
    };
  }

  /** "Sprawdź bon": everyone in the salon, by the code the client shows (any letter case, spaces). */
  async findByCode(
    m: MembershipContext,
    locationId: string,
    code: string,
  ): Promise<GiftVoucherDetailsResponse> {
    const location = await this.access.readable(m, locationId);
    const voucher = await this.prisma.giftVoucher.findUnique({
      where: { locationId_code: { locationId, code } },
    });
    if (!voucher) throw notFound('Gift voucher');
    return this.details(voucher, location);
  }

  async get(
    m: MembershipContext,
    locationId: string,
    voucherId: string,
  ): Promise<GiftVoucherDetailsResponse> {
    const location = await this.access.readable(m, locationId);
    const voucher = await this.prisma.giftVoucher.findFirst({
      where: { id: voucherId, locationId },
    });
    if (!voucher) throw notFound('Gift voucher');
    return this.details(voucher, location);
  }

  /**
   * "Zapłać bonem": takes the amount from what is left, in one step. Cancelled → 409
   * VOUCHER_CANCELLED, past its last day → 409 VOUCHER_EXPIRED, more than is left → 409
   * VOUCHER_BALANCE; nothing is changed then.
   */
  async redeem(
    m: MembershipContext,
    userId: string,
    locationId: string,
    voucherId: string,
    input: RedeemGiftVoucherInput,
  ): Promise<GiftVoucherDetailsResponse> {
    const location = await this.access.readable(m, locationId);
    const voucher = await this.prisma.giftVoucher.findFirst({
      where: { id: voucherId, locationId },
    });
    if (!voucher) throw notFound('Gift voucher');
    const today = localToday(Date.now(), location.timezone);
    if (voucher.cancelledAt) {
      throw new AppException(HttpStatus.CONFLICT, 'VOUCHER_CANCELLED', 'The voucher was cancelled');
    }
    if (voucher.validUntil && dateString(voucher.validUntil) < today) {
      throw new AppException(HttpStatus.CONFLICT, 'VOUCHER_EXPIRED', 'The voucher has expired');
    }
    const taken = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.giftVoucher.updateMany({
        where: {
          id: voucherId,
          cancelledAt: null,
          balanceGrosze: { gte: input.amountGrosze },
        },
        data: { balanceGrosze: { decrement: input.amountGrosze } },
      });
      if (updated.count === 0) return false;
      await tx.giftVoucherUse.create({
        data: {
          voucherId,
          amountGrosze: input.amountGrosze,
          note: input.note ?? null,
          createdByUserId: userId,
        },
      });
      return true;
    });
    const after = await this.prisma.giftVoucher.findUniqueOrThrow({ where: { id: voucherId } });
    if (!taken) {
      if (after.cancelledAt) {
        throw new AppException(
          HttpStatus.CONFLICT,
          'VOUCHER_CANCELLED',
          'The voucher was cancelled',
        );
      }
      throw new AppException(
        HttpStatus.CONFLICT,
        'VOUCHER_BALANCE',
        `Only ${after.balanceGrosze} is left on the voucher`,
      );
    }
    return this.details(after, location);
  }

  /**
   * Task 498: "Zmień bon" — owners and managers move the last day (also to give an expired voucher
   * more time), fix who it is for and the note. The amount and what is left are not changed here.
   */
  async update(
    m: MembershipContext,
    locationId: string,
    voucherId: string,
    input: UpdateGiftVoucherInput,
  ): Promise<GiftVoucherResponse> {
    const location = await this.access.writable(m, locationId);
    const voucher = await this.prisma.giftVoucher.findFirst({
      where: { id: voucherId, locationId },
    });
    if (!voucher) throw notFound('Gift voucher');
    if (voucher.cancelledAt) {
      throw new AppException(HttpStatus.CONFLICT, 'VOUCHER_CANCELLED', 'The voucher was cancelled');
    }
    if (input.validUntil && input.validUntil < localToday(Date.now(), location.timezone)) {
      throw new AppException(
        HttpStatus.BAD_REQUEST,
        'VOUCHER_DATE_PAST',
        'The voucher cannot end before today',
      );
    }
    const updated = await this.prisma.giftVoucher.update({
      where: { id: voucherId },
      data: {
        ...(input.validUntil !== undefined && {
          validUntil: input.validUntil ? dateValue(input.validUntil) : null,
        }),
        ...(input.recipient !== undefined && { recipient: input.recipient }),
        ...(input.note !== undefined && { note: input.note }),
      },
    });
    return this.toVoucher(updated, location, await this.names([updated.createdByUserId]));
  }

  /** Owners and managers: sold by mistake or the money returned; the voucher cannot be used then. */
  async cancel(
    m: MembershipContext,
    locationId: string,
    voucherId: string,
  ): Promise<GiftVoucherResponse> {
    const location = await this.access.writable(m, locationId);
    const voucher = await this.prisma.giftVoucher.findFirst({
      where: { id: voucherId, locationId },
    });
    if (!voucher) throw notFound('Gift voucher');
    const updated = voucher.cancelledAt
      ? voucher
      : await this.prisma.giftVoucher.update({
          where: { id: voucherId },
          data: { cancelledAt: new Date() },
        });
    return this.toVoucher(updated, location, await this.names([updated.createdByUserId]));
  }
}
