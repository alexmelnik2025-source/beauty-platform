import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException, notFound } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { todayHoursOf } from '../scheduling/today-hours';
import type { ClientFavoritesResponse } from './client-favorites.responses';
import type { ClientAuth } from './client.service';

/** A client keeps at most this many favourite salons. */
export const MAX_FAVORITES = 100;

/**
 * "Favourite salons" of a signed-in client. Rows belong to the person only: salons never see
 * who saved them, and a client never sees anyone else's list.
 */
@Injectable()
export class ClientFavoritesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(client: ClientAuth): Promise<ClientFavoritesResponse> {
    const rows = await this.prisma.clientFavorite.findMany({
      where: { personId: client.personId },
      select: {
        createdAt: true,
        location: {
          select: {
            id: true,
            timezone: true,
            staffMembers: {
              // Those who take online bookings: their hours are the salon's (task 362).
              where: { active: true, services: { some: { service: { active: true } } } },
              select: {
                id: true,
                workingHours: { select: { weekday: true, startMinute: true, endMinute: true } },
              },
            },
            slug: true,
            name: true,
            addressLine: true,
            city: true,
            postalCode: true,
            onlineBookingEnabled: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { locationId: 'asc' }],
    });
    // Task 367: "Otwarte teraz" on the cards — only for salons a client can book.
    const today = await todayHoursOf(
      this.prisma,
      rows
        .filter((row) => row.location.onlineBookingEnabled)
        .map(({ location: l }) => ({ id: l.id, timezone: l.timezone, staff: l.staffMembers })),
    );
    return {
      items: rows.map(
        ({ createdAt, location: { id, staffMembers: _s, onlineBookingEnabled, ...salon } }) => ({
          ...salon,
          bookable: onlineBookingEnabled,
          addedAt: createdAt.toISOString(),
          todayHours: onlineBookingEnabled ? (today.get(id)?.intervals ?? []) : [],
        }),
      ),
    };
  }

  /** Saving a salon twice keeps the first date. Only salons open for online booking. */
  async add(client: ClientAuth, slug: string): Promise<void> {
    const location = await this.prisma.location.findFirst({
      where: { slug, onlineBookingEnabled: true },
      select: { id: true },
    });
    if (!location) throw notFound('Location');
    const key = { personId: client.personId, locationId: location.id };
    const existing = await this.prisma.clientFavorite.findUnique({
      where: { personId_locationId: key },
      select: { createdAt: true },
    });
    if (existing) return;
    const count = await this.prisma.clientFavorite.count({
      where: { personId: client.personId },
    });
    if (count >= MAX_FAVORITES) {
      throw new AppException(
        HttpStatus.CONFLICT,
        'TOO_MANY_FAVORITES',
        `At most ${MAX_FAVORITES} favourite salons`,
      );
    }
    await this.prisma.clientFavorite.upsert({
      where: { personId_locationId: key },
      create: key,
      update: {},
    });
  }

  /** Removing a salon that is not on the list (or no longer exists) is not an error. */
  async remove(client: ClientAuth, slug: string): Promise<void> {
    await this.prisma.clientFavorite.deleteMany({
      where: { personId: client.personId, location: { slug } },
    });
  }
}
