import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Request } from 'express';
import { AppException, notFound } from '../common/app-exception';
import { hashToken } from '../common/crypto';
import type { MembershipContext } from '../common/request-context';
import { APP_CONFIG, type AppConfig } from '../config/config';
import type { Appointment, VisitPhoto } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { readImageBody } from '../scheduling/photos.service';
import { AppointmentsService } from './appointments.service';
import type { VisitPhotoListResponse, VisitPhotoResponse } from './visit-photos.responses';

/** "Pokaż, co chcesz": at most this many photos per visit. */
export const MAX_VISIT_PHOTOS = 3;
/** Photos are deleted this many days after the visit ends. */
export const KEEP_DAYS = 90;
/** A signed link to a picture works this long. */
const LINK_SECONDS = 60 * 60;
const DAY_MS = 86_400_000;
const EVERY_MS = 60 * 60_000;

const fields = {
  id: true,
  contentType: true,
  sizeBytes: true,
  createdAt: true,
} as const;
type PhotoRow = Pick<VisitPhoto, 'id' | 'contentType' | 'sizeBytes' | 'createdAt'>;

const notAsked = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'PHOTOS_NOT_ASKED',
    'The salon does not ask for example photos for this service',
  );
const tooMany = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'TOO_MANY_PHOTOS',
    `At most ${MAX_VISIT_PHOTOS} photos per visit`,
  );
const holdExpired = (): AppException =>
  new AppException(HttpStatus.GONE, 'HOLD_EXPIRED', 'The time is no longer held: pick it again');
const tooLate = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'TOO_LATE_TO_CHANGE',
    'The visit has started: the photos can no longer be changed',
  );

/**
 * Task 80b: example photos the client adds when booking ("Pokaż, co chcesz"), for services
 * where the salon switched it on. Added to the hold (with its token), so they come with the
 * confirmed visit; the specialist sees them like the visit note; the client can remove them
 * by the visit link until the visit starts. Deleted 90 days after the visit, at once for
 * holds never confirmed and cancelled visits, and when the client's data is erased.
 * The pictures are served by signed links valid for an hour, so <img> works without a header.
 */
@Injectable()
export class VisitPhotosService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('VisitPhotos');
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly appointments: AppointmentsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.OUTBOX_POLL_MS > 0) {
      this.timer = setInterval(() => void this.tick(), EVERY_MS);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    try {
      const removed = await this.purge();
      if (removed > 0) this.logger.log(`Deleted ${removed} old visit photos`);
    } catch (error) {
      this.logger.error(`Purge failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  // ── While booking (the hold) ──────────────────────────

  async addToHold(holdId: string, holdToken: string, req: Request): Promise<VisitPhotoResponse> {
    const hold = await this.activeHold(holdId, holdToken);
    const count = await this.prisma.visitPhoto.count({ where: { appointmentId: hold.id } });
    if (count >= MAX_VISIT_PHOTOS) throw tooMany();
    const { bytes, type } = await readImageBody(req);
    const photo = await this.prisma.$transaction(async (tx) => {
      const again = await tx.visitPhoto.count({ where: { appointmentId: hold.id } });
      if (again >= MAX_VISIT_PHOTOS) throw tooMany();
      return tx.visitPhoto.create({
        data: {
          appointmentId: hold.id,
          locationId: hold.locationId,
          contentType: type,
          sizeBytes: bytes.length,
          data: new Uint8Array(bytes),
        },
        select: fields,
      });
    });
    return this.toResponse(photo);
  }

  async listForHold(holdId: string, holdToken: string): Promise<VisitPhotoListResponse> {
    const hold = await this.activeHold(holdId, holdToken);
    return { items: await this.list(hold.id), deleteAfter: null };
  }

  async removeFromHold(holdId: string, holdToken: string, photoId: string): Promise<void> {
    const hold = await this.activeHold(holdId, holdToken);
    const removed = await this.prisma.visitPhoto.deleteMany({
      where: { id: photoId, appointmentId: hold.id },
    });
    if (removed.count !== 1) throw notFound('Photo');
  }

  // ── The client's visit link ───────────────────────────

  async listByManageToken(token: string): Promise<VisitPhotoListResponse> {
    const visit = await this.byManageToken(token);
    return { items: await this.list(visit.id), deleteAfter: this.deleteAfter(visit) };
  }

  /** Until the visit starts; after that the specialist may still need them. */
  async removeByManageToken(token: string, photoId: string): Promise<void> {
    await this.removeFromVisit(await this.byManageToken(token), photoId);
  }

  // ── The signed-in client ("My visits" in the app) ─────

  /** Task 80j: the photos of one of the client's visits (the caller checks it is theirs). */
  async listForVisit(visit: Pick<Appointment, 'id' | 'endAt'>): Promise<VisitPhotoListResponse> {
    return { items: await this.list(visit.id), deleteAfter: this.deleteAfter(visit) };
  }

  /** Removes a photo of the client's own visit, until the visit starts (409 TOO_LATE_TO_CHANGE). */
  async removeFromVisit(
    visit: Pick<Appointment, 'id' | 'status' | 'startAt'>,
    photoId: string,
  ): Promise<void> {
    if (visit.status !== 'confirmed' || Date.now() >= visit.startAt.getTime()) throw tooLate();
    const removed = await this.prisma.visitPhoto.deleteMany({
      where: { id: photoId, appointmentId: visit.id },
    });
    if (removed.count !== 1) throw notFound('Photo');
  }

  // ── The salon ─────────────────────────────────────────

  /** Whoever may see the visit (and its note) sees its photos. */
  async listForStaff(
    m: MembershipContext,
    userId: string,
    locationId: string,
    appointmentId: string,
  ): Promise<VisitPhotoListResponse> {
    const visit = await this.appointments.visible(m, userId, locationId, appointmentId);
    return { items: await this.list(visit.id), deleteAfter: this.deleteAfter(visit) };
  }

  // ── The picture by its signed link ────────────────────

  signedUrl(photoId: string, now = Date.now()): string {
    const exp = Math.floor(now / 1000) + LINK_SECONDS;
    return `/v1/public/visit-photos/${photoId}?exp=${exp}&sig=${this.sign(photoId, exp)}`;
  }

  async file(photoId: string, exp: string, sig: string): Promise<VisitPhoto> {
    const expires = Number(exp);
    const expected = Buffer.from(this.sign(photoId, expires));
    const given = Buffer.from(String(sig));
    if (
      !Number.isInteger(expires) ||
      expires * 1000 <= Date.now() ||
      expected.length !== given.length ||
      !timingSafeEqual(expected, given)
    ) {
      throw notFound('Photo');
    }
    const photo = await this.prisma.visitPhoto.findUnique({ where: { id: photoId } });
    if (!photo) throw notFound('Photo');
    return photo;
  }

  // ── Deleting ──────────────────────────────────────────

  /**
   * Deletes the photos of visits that ended 90 days ago, of holds that were never confirmed
   * and of cancelled visits. Returns how many were deleted. Tests call it directly.
   */
  async purge(now = Date.now()): Promise<number> {
    const result = await this.prisma.visitPhoto.deleteMany({
      where: {
        appointment: {
          OR: [
            { endAt: { lt: new Date(now - KEEP_DAYS * DAY_MS) } },
            { status: { in: ['expired', 'cancelled'] } },
            { status: 'held', holdExpiresAt: { lt: new Date(now) } },
          ],
        },
      },
    });
    return result.count;
  }

  // ── Helpers ───────────────────────────────────────────

  private sign(photoId: string, exp: number): string {
    return createHmac('sha256', this.config.JWT_ACCESS_SECRET)
      .update(`visit-photo:${photoId}:${exp}`)
      .digest('hex');
  }

  private toResponse(p: PhotoRow): VisitPhotoResponse {
    return {
      id: p.id,
      url: this.signedUrl(p.id),
      contentType: p.contentType,
      sizeBytes: p.sizeBytes,
      createdAt: p.createdAt.toISOString(),
    };
  }

  private async list(appointmentId: string): Promise<VisitPhotoResponse[]> {
    const rows = await this.prisma.visitPhoto.findMany({
      where: { appointmentId },
      select: fields,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((p) => this.toResponse(p));
  }

  private deleteAfter(visit: Pick<Appointment, 'endAt'>): string {
    return new Date(visit.endAt.getTime() + KEEP_DAYS * DAY_MS).toISOString();
  }

  private async activeHold(holdId: string, holdToken: string) {
    const hold = await this.prisma.appointment.findFirst({
      where: { id: holdId, holdTokenHash: hashToken(String(holdToken ?? '')) },
      include: { service: { select: { wishPhotos: true } } },
    });
    if (!hold) throw notFound('Hold');
    if (
      hold.status !== 'held' ||
      !hold.holdExpiresAt ||
      hold.holdExpiresAt.getTime() <= Date.now()
    ) {
      throw holdExpired();
    }
    if (!hold.service.wishPhotos) throw notAsked();
    return hold;
  }

  private async byManageToken(token: string): Promise<Appointment> {
    const access = await this.prisma.appointmentAccessToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { appointment: true },
    });
    if (!access || access.expiresAt.getTime() <= Date.now()) throw notFound('Appointment');
    return access.appointment;
  }
}
