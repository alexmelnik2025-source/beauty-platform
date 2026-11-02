import { HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AppException, notFound } from '../common/app-exception';
import { AuditService } from '../common/audit.service';
import type { MembershipContext } from '../common/request-context';
import type { PhotoResponse } from '../common/system.responses';
import type { Prisma } from '../generated/prisma/client';
import { LocationAccessService } from '../organizations/location-access.service';
import { PrismaService } from '../prisma/prisma.service';

/** The web app shrinks pictures before sending; this is a safety limit, not the usual size. */
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
/** Photos in a salon's gallery (staff portraits are counted separately, one each). */
export const MAX_SALON_PHOTOS = 10;

export type { PhotoResponse } from '../common/system.responses';

export const photoUrl = (id: string): string => `/v1/public/photos/${id}`;

const photoFields = { id: true, contentType: true, sizeBytes: true, createdAt: true } as const;

const toPhoto = (p: {
  id: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
}): PhotoResponse => ({
  id: p.id,
  url: photoUrl(p.id),
  contentType: p.contentType,
  sizeBytes: p.sizeBytes,
  createdAt: p.createdAt.toISOString(),
});

const tooLarge = (): AppException =>
  new AppException(
    HttpStatus.PAYLOAD_TOO_LARGE,
    'PHOTO_TOO_LARGE',
    `A photo may be at most ${MAX_PHOTO_BYTES / 1024 / 1024} MB`,
  );

const unsupported = (): AppException =>
  new AppException(
    HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    'UNSUPPORTED_PHOTO',
    'Send the picture itself (JPEG, PNG or WebP) as the request body',
  );

/** The real type of a picture, from its first bytes; null for anything else (HTML, SVG, PDF…). */
export function detectImageType(
  bytes: Uint8Array,
): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (bytes.length >= 3 && starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (bytes.length >= 8 && starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    starts([0x52, 0x49, 0x46, 0x46]) &&
    starts([0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Reads the uploaded picture from the request body (sent as is, Content-Type image/*),
 * stopping as soon as it is larger than the limit.
 */
export async function readImageBody(req: Request): Promise<{ bytes: Buffer; type: string }> {
  if (!/^image\//i.test(req.headers['content-type'] ?? '')) throw unsupported();
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_PHOTO_BYTES) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_PHOTO_BYTES) throw tooLarge();
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const type = detectImageType(bytes);
  if (!type) throw unsupported();
  return { bytes, type };
}

/** Salon gallery and staff portraits. Reads: any member with access; writes: owner or manager. */
@Injectable()
export class PhotosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LocationAccessService,
    private readonly audit: AuditService,
  ) {}

  async listSalonPhotos(m: MembershipContext, locationId: string): Promise<PhotoResponse[]> {
    await this.access.readable(m, locationId);
    const photos = await this.prisma.photo.findMany({
      where: { locationId, staffId: null },
      select: photoFields,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return photos.map(toPhoto);
  }

  async addSalonPhoto(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    req: Request,
  ): Promise<PhotoResponse> {
    await this.access.writable(m, locationId);
    const count = await this.prisma.photo.count({ where: { locationId, staffId: null } });
    if (count >= MAX_SALON_PHOTOS) throw tooMany();
    const { bytes, type } = await readImageBody(req);
    const photo = await this.prisma.$transaction(async (tx) => {
      const again = await tx.photo.count({ where: { locationId, staffId: null } });
      if (again >= MAX_SALON_PHOTOS) throw tooMany();
      const created = await tx.photo.create({
        data: {
          locationId,
          contentType: type,
          sizeBytes: bytes.length,
          data: new Uint8Array(bytes),
        },
        select: photoFields,
      });
      await this.record(tx, m, actorUserId, 'photo.added', 'photo', created.id);
      return created;
    });
    return toPhoto(photo);
  }

  async removeSalonPhoto(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    photoId: string,
  ): Promise<void> {
    await this.access.writable(m, locationId);
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.photo.deleteMany({
        where: { id: photoId, locationId, staffId: null },
      });
      if (result.count !== 1) throw notFound('Photo');
      await this.record(tx, m, actorUserId, 'photo.removed', 'photo', photoId);
    });
  }

  /** Replaces the staff member's portrait; the old picture (and its link) is gone. */
  async setStaffPhoto(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    staffId: string,
    req: Request,
  ): Promise<PhotoResponse> {
    await this.access.writable(m, locationId);
    await this.findStaff(locationId, staffId);
    const { bytes, type } = await readImageBody(req);
    const photo = await this.prisma.$transaction(async (tx) => {
      await tx.photo.deleteMany({ where: { staffId } });
      const created = await tx.photo.create({
        data: {
          locationId,
          staffId,
          contentType: type,
          sizeBytes: bytes.length,
          data: new Uint8Array(bytes),
        },
        select: photoFields,
      });
      await this.record(tx, m, actorUserId, 'staff.photo_set', 'staff_member', staffId);
      return created;
    });
    return toPhoto(photo);
  }

  async removeStaffPhoto(
    m: MembershipContext,
    actorUserId: string,
    locationId: string,
    staffId: string,
  ): Promise<void> {
    await this.access.writable(m, locationId);
    await this.findStaff(locationId, staffId);
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.photo.deleteMany({ where: { staffId } });
      if (result.count !== 1) throw notFound('Photo');
      await this.record(tx, m, actorUserId, 'staff.photo_removed', 'staff_member', staffId);
    });
  }

  /** The picture itself, for the public link. */
  async file(photoId: string): Promise<{ contentType: string; data: Uint8Array }> {
    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
      select: { contentType: true, data: true },
    });
    if (!photo) throw notFound('Photo');
    return photo;
  }

  private async findStaff(locationId: string, staffId: string): Promise<void> {
    const staff = await this.prisma.staffMember.findFirst({
      where: { id: staffId, locationId },
      select: { id: true },
    });
    if (!staff) throw notFound('Staff member');
  }

  private record(
    tx: Prisma.TransactionClient,
    m: MembershipContext,
    actorUserId: string,
    action: string,
    entityType: string,
    entityId: string,
  ): Promise<void> {
    return this.audit.record(
      { organizationId: m.organizationId, actorUserId, action, entityType, entityId },
      tx,
    );
  }
}

const tooMany = (): AppException =>
  new AppException(
    HttpStatus.CONFLICT,
    'TOO_MANY_PHOTOS',
    `A salon may have at most ${MAX_SALON_PHOTOS} photos. Remove one first`,
  );
