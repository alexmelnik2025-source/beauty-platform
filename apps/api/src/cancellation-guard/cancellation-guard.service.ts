import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, notFound } from '../common/app-exception';
import { AuditService } from '../common/audit.service';
import type { MembershipContext } from '../common/request-context';
import type { CancellationGuard } from '../generated/prisma/client';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CancellationGuardResponse,
  GuardedClientResponse,
  GuardedClientsResponse,
  GUARD_REASONS,
} from './cancellation-guard.responses';
import type {
  ReleaseCustomerInput,
  UpdateCancellationGuardInput,
} from './cancellation-guard.schemas';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Late cancellations and no-shows older than this are not counted any more. */
export const GUARD_LOOKBACK_DAYS = 365;
const HISTORY_LIMIT = 50;

export type GuardReason = (typeof GUARD_REASONS)[number];
export type GuardSettings = Pick<
  CancellationGuard,
  'enabled' | 'maxChanges' | 'windowHours' | 'lateCancelMinutes' | 'maxNoShows' | 'action'
>;

/** Off, with every rule empty: what a salon has until it saves its own settings. */
export const DEFAULT_GUARD: GuardSettings = {
  enabled: false,
  maxChanges: null,
  windowHours: 720,
  lateCancelMinutes: null,
  maxNoShows: null,
  action: 'approval',
};

/** One thing the client did at the salon that the guard counts. */
export interface GuardIncident {
  type: 'cancelled' | 'rescheduled' | 'no_show';
  /** When it happened; for a no-show — the start of the missed visit. */
  at: Date;
  /** The visit's start (for a cancellation — the time that was cancelled). */
  visitStart: Date;
  appointmentId: string;
  /** For a no-show: the price of the missed visit after discounts. */
  amountGrosze: number;
}

export interface GuardVerdict {
  reasons: GuardReason[];
  changes: number;
  lateCancellations: number;
  noShows: number;
  noShowAmountGrosze: number;
}

/** A cancellation by the client less than `lateCancelMinutes` before the visit. */
export function isLate(settings: GuardSettings, incident: GuardIncident): boolean {
  return (
    incident.type === 'cancelled' &&
    settings.lateCancelMinutes !== null &&
    incident.visitStart.getTime() - incident.at.getTime() < settings.lateCancelMinutes * MINUTE
  );
}

/**
 * The guard's rules on one client's incidents since the salon last lifted the mark:
 * N cancellations/reschedules within the window, any late cancellation, M no-shows.
 * A rule left empty never marks anyone; the counters are returned either way.
 */
export function evaluateGuard(
  settings: GuardSettings,
  incidents: GuardIncident[],
  now: Date,
): GuardVerdict {
  const windowStart = now.getTime() - settings.windowHours * HOUR;
  let changes = 0;
  let lateCancellations = 0;
  let noShows = 0;
  let noShowAmountGrosze = 0;
  for (const i of incidents) {
    if (i.type === 'no_show') {
      noShows += 1;
      noShowAmountGrosze += i.amountGrosze;
      continue;
    }
    if (i.at.getTime() >= windowStart) changes += 1;
    if (isLate(settings, i)) lateCancellations += 1;
  }
  const reasons: GuardReason[] = [];
  if (settings.maxChanges !== null && changes >= settings.maxChanges) reasons.push('changes');
  if (lateCancellations > 0) reasons.push('late_cancel');
  if (settings.maxNoShows !== null && noShows >= settings.maxNoShows) reasons.push('no_shows');
  return { reasons, changes, lateCancellations, noShows, noShowAmountGrosze };
}

/**
 * Task 161: "Ochrona przed odwołaniami". Each location may turn on rules for clients who often
 * cancel, move or miss visits; the mark is counted from the visit history on every read (nothing
 * to keep in sync), and the salon lifts it by hand — counting then starts again. Owners and
 * managers of the location only; clients of another organization are never counted or shown.
 */
@Injectable()
export class CancellationGuardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LocationAccessService,
    private readonly audit: AuditService,
  ) {}

  async get(m: MembershipContext, locationId: string): Promise<CancellationGuardResponse> {
    await this.access.readable(m, locationId);
    const row = await this.prisma.cancellationGuard.findUnique({ where: { locationId } });
    return toResponse(row);
  }

  async update(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    input: UpdateCancellationGuardInput,
  ): Promise<CancellationGuardResponse> {
    await this.access.writable(m, locationId);
    const { version, ...data } = input;
    const saved = await this.prisma.$transaction(async (tx) => {
      const current = await tx.cancellationGuard.findUnique({ where: { locationId } });
      if ((current?.version ?? 0) !== version) throw conflict();
      let row: CancellationGuard;
      if (current) {
        const result = await tx.cancellationGuard.updateMany({
          where: { locationId, version },
          data: { ...data, version: { increment: 1 } },
        });
        if (result.count !== 1) throw conflict();
        row = await tx.cancellationGuard.findUniqueOrThrow({ where: { locationId } });
      } else {
        row = await tx.cancellationGuard.create({ data: { locationId, ...data } }).catch(() => {
          // Someone else saved the first version at the same moment.
          throw conflict();
        });
      }
      const fields = (Object.keys(data) as (keyof typeof data)[]).filter(
        (k) => (current ?? DEFAULT_GUARD)[k] !== data[k],
      );
      await this.audit.record(
        {
          organizationId: m.organizationId,
          actorUserId,
          action: 'location.cancellation_guard_set',
          entityType: 'location',
          entityId: locationId,
          metadata: { fields },
        },
        tx,
      );
      return row;
    });
    return toResponse(saved);
  }

  /** The clients the guard marks now, most incidents first. Empty while the guard is off. */
  async clients(
    m: MembershipContext,
    locationId: string,
    now = new Date(),
  ): Promise<GuardedClientsResponse> {
    const location = await this.access.writable(m, locationId);
    const settings = await this.settings(locationId);
    const base = {
      enabled: settings.enabled,
      action: settings.action,
      currency: location.currency,
    };
    if (!settings.enabled) return { ...base, items: [] };
    const { incidents, releases } = await this.load(locationId, null, now);
    const marked = new Map<string, GuardVerdict>();
    for (const [customerId, list] of incidents) {
      const verdict = evaluateGuard(settings, list, now);
      if (verdict.reasons.length > 0) marked.set(customerId, verdict);
    }
    if (marked.size === 0) return { ...base, items: [] };
    const customers = await this.prisma.customer.findMany({
      where: {
        id: { in: [...marked.keys()] },
        organizationId: m.organizationId,
        anonymizedAt: null,
      },
      select: { id: true, name: true, phone: true, email: true },
    });
    const items = customers.map((c) => {
      const v = marked.get(c.id)!;
      return {
        customerId: c.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        ...v,
        releasedAt: releases.get(c.id)?.toISOString() ?? null,
      };
    });
    items.sort(
      (a, b) =>
        b.noShows +
          b.changes +
          b.lateCancellations -
          (a.noShows + a.changes + a.lateCancellations) || a.name.localeCompare(b.name, 'pl'),
    );
    return { ...base, items };
  }

  /** One client's status and history at the location (for the client's card). */
  async client(
    m: MembershipContext,
    locationId: string,
    customerId: string,
    now = new Date(),
  ): Promise<GuardedClientResponse> {
    const location = await this.access.writable(m, locationId);
    await this.customerOf(m, customerId);
    const settings = await this.settings(locationId);
    const { incidents, releases, all } = await this.load(locationId, customerId, now);
    const verdict = evaluateGuard(settings, incidents.get(customerId) ?? [], now);
    const releaseRows = await this.prisma.cancellationGuardRelease.findMany({
      where: {
        locationId,
        customerId,
        createdAt: { gte: new Date(now.getTime() - GUARD_LOOKBACK_DAYS * DAY) },
      },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_LIMIT,
    });
    const history = [
      ...all.map((i) => ({
        type: i.type,
        at: i.at.toISOString(),
        visitStart: i.visitStart.toISOString(),
        late: isLate(settings, i),
        appointmentId: i.appointmentId,
        note: null,
      })),
      ...releaseRows.map((r) => ({
        type: 'released' as const,
        at: r.createdAt.toISOString(),
        visitStart: null,
        late: false,
        appointmentId: null,
        note: r.note,
      })),
    ]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, HISTORY_LIMIT);
    return {
      customerId,
      enabled: settings.enabled,
      action: settings.action,
      currency: location.currency,
      flagged: settings.enabled && verdict.reasons.length > 0,
      ...verdict,
      releasedAt: releases.get(customerId)?.toISOString() ?? null,
      history,
    };
  }

  /** "Zdejmij blokadę": counting for the client starts again from now. */
  async release(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    customerId: string,
    input: ReleaseCustomerInput,
  ): Promise<GuardedClientResponse> {
    await this.access.writable(m, locationId);
    await this.customerOf(m, customerId);
    await this.prisma.$transaction(async (tx) => {
      await tx.cancellationGuardRelease.create({
        data: { locationId, customerId, releasedByUserId: actorUserId, note: input.note || null },
      });
      await this.audit.record(
        {
          organizationId: m.organizationId,
          actorUserId,
          action: 'customer.guard_released',
          entityType: 'customer',
          entityId: customerId,
        },
        tx,
      );
    });
    return this.client(m, locationId, customerId);
  }

  /**
   * Whether the guard marks this client at the location now (for bookings, task 161b).
   * null when the guard is off or the client is not marked.
   */
  async check(
    locationId: string,
    customerId: string,
    now = new Date(),
  ): Promise<(GuardVerdict & { action: GuardSettings['action'] }) | null> {
    const settings = await this.settings(locationId);
    if (!settings.enabled) return null;
    const { incidents } = await this.load(locationId, customerId, now);
    const verdict = evaluateGuard(settings, incidents.get(customerId) ?? [], now);
    return verdict.reasons.length > 0 ? { ...verdict, action: settings.action } : null;
  }

  private async settings(locationId: string): Promise<GuardSettings> {
    return (
      (await this.prisma.cancellationGuard.findUnique({ where: { locationId } })) ?? DEFAULT_GUARD
    );
  }

  private async customerOf(m: MembershipContext, customerId: string): Promise<void> {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, organizationId: m.organizationId },
      select: { id: true },
    });
    if (!customer) throw notFound('Customer');
  }

  /**
   * The incidents of the last year at the location (of one client, or of every client), split
   * into those after each client's last release (counted) and all of them (the history).
   */
  private async load(
    locationId: string,
    customerId: string | null,
    now: Date,
  ): Promise<{
    incidents: Map<string, GuardIncident[]>;
    releases: Map<string, Date>;
    all: GuardIncident[];
  }> {
    const since = new Date(now.getTime() - GUARD_LOOKBACK_DAYS * DAY);
    const customer = customerId ?? { not: null };
    const [events, noShows, lastReleases] = await Promise.all([
      this.prisma.appointmentEvent.findMany({
        where: {
          actor: 'customer',
          type: { in: ['cancelled', 'rescheduled'] },
          createdAt: { gte: since, lte: now },
          appointment: { locationId, customerId: customer },
        },
        select: {
          type: true,
          createdAt: true,
          appointmentId: true,
          appointment: { select: { customerId: true, startAt: true } },
        },
      }),
      this.prisma.appointment.findMany({
        where: {
          locationId,
          customerId: customer,
          status: 'no_show',
          startAt: { gte: since, lte: now },
        },
        select: {
          id: true,
          customerId: true,
          startAt: true,
          priceGrosze: true,
          discountGrosze: true,
        },
      }),
      this.prisma.cancellationGuardRelease.groupBy({
        by: ['customerId'],
        where: { locationId, ...(customerId ? { customerId } : {}) },
        _max: { createdAt: true },
      }),
    ]);
    const releases = new Map<string, Date>();
    for (const r of lastReleases)
      if (r._max.createdAt) releases.set(r.customerId, r._max.createdAt);

    const incidents = new Map<string, GuardIncident[]>();
    const all: GuardIncident[] = [];
    const add = (owner: string, incident: GuardIncident) => {
      if (customerId) all.push(incident);
      const released = releases.get(owner);
      if (released && incident.at.getTime() <= released.getTime()) return;
      const list = incidents.get(owner);
      if (list) list.push(incident);
      else incidents.set(owner, [incident]);
    };
    for (const e of events) {
      if (!e.appointment.customerId) continue;
      add(e.appointment.customerId, {
        type: e.type === 'cancelled' ? 'cancelled' : 'rescheduled',
        at: e.createdAt,
        visitStart: e.appointment.startAt,
        appointmentId: e.appointmentId,
        amountGrosze: 0,
      });
    }
    for (const a of noShows) {
      if (!a.customerId) continue;
      add(a.customerId, {
        type: 'no_show',
        at: a.startAt,
        visitStart: a.startAt,
        appointmentId: a.id,
        amountGrosze: Math.max(0, a.priceGrosze - a.discountGrosze),
      });
    }
    return { incidents, releases, all };
  }
}

function toResponse(row: CancellationGuard | null): CancellationGuardResponse {
  const s = row ?? DEFAULT_GUARD;
  return {
    enabled: s.enabled,
    maxChanges: s.maxChanges,
    windowHours: s.windowHours,
    lateCancelMinutes: s.lateCancelMinutes,
    maxNoShows: s.maxNoShows,
    action: s.action,
    version: row?.version ?? 0,
  };
}

const conflict = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'VERSION_CONFLICT',
    'The settings were changed by someone else. Reload and try again',
  );
