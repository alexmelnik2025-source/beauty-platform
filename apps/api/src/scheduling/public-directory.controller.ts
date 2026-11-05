import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { languageSchema, specialtySchema } from '../common/enums.schemas';
import type { Prisma } from '../generated/prisma/client';
import { photoUrl } from './photos.service';
import { ApiZodResponse } from '../common/openapi';
import type { AppRequest } from '../common/request-context';
import { RateLimiterService } from '../common/rate-limiter.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.service';
import {
  publicDirectoryQuerySchema,
  publicDirectorySchema,
  type PublicDirectoryQuery,
  type PublicDirectoryResponse,
} from './public-directory.schemas';

/** Languages in the order the catalogue shows them. */
const SPOKEN = languageSchema.options;
/** Kinds of place (task 160), in the order the catalogue shows them. */
const KINDS = specialtySchema.options;

type Language = (typeof SPOKEN)[number];
type Kind = (typeof KINDS)[number];

/**
 * Only salons a client can actually book: online booking on, with a service and a staff member.
 * A language matches when the salon or one of its active staff members speaks it; a kind of
 * place when one of its active staff members does it.
 */
function catalogueWhere(
  languages: Language[],
  specialty?: Kind,
  ids?: string[],
): Prisma.LocationWhereInput {
  const and: Prisma.LocationWhereInput[] = [
    {
      onlineBookingEnabled: true,
      services: { some: { active: true } },
      staffMembers: { some: { active: true } },
    },
  ];
  // Task 180b: the salons found by name, service or city.
  if (ids) and.push({ id: { in: ids } });
  // Task 192: several languages - any one of them (OR).
  if (languages.length > 0) {
    and.push({
      OR: [
        { languages: { hasSome: languages } },
        { staffMembers: { some: { active: true, languages: { hasSome: languages } } } },
      ],
    });
  }
  if (specialty) {
    and.push({ staffMembers: { some: { active: true, specialties: { has: specialty } } } });
  }
  return { AND: and };
}

/** Lower case without accents: "Łódź" → "lodz", "Strzyżenie" → "strzyzenie". */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/** Every word of the search is in the salon's name or in one of its services' names. */
export function matchesSearch(search: string, names: string[]): boolean {
  const words = fold(search).split(/\s+/).filter(Boolean);
  const haystack = names.map(fold).join(' | ');
  return words.every((word) => haystack.includes(word));
}

/** Great-circle distance in kilometres, rounded to one decimal. */
export function distanceKm(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(to.latitude - from.latitude);
  const dLon = rad(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(from.latitude)) * Math.cos(rad(to.latitude)) * Math.sin(dLon / 2) ** 2;
  return Math.round(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

@ApiTags('public')
@Public()
@Controller('public/locations')
export class PublicDirectoryController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly limiter: RateLimiterService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Salons open for online booking, by city: for the catalogue and its map',
    description:
      'Only public salon data: no organization, staff or contact details. `priceFromGrosze` is the lowest bookable price (task 91).',
  })
  @ApiQuery({
    name: 'language',
    required: false,
    type: String,
    example: 'uk,ru',
    description:
      'Spoken by the salon or by one of its staff members; several codes comma-separated = any of them (task 192). ' +
      `Codes: ${SPOKEN.join(', ')}`,
  })
  @ApiQuery({
    name: 'specialty',
    required: false,
    enum: KINDS,
    description: 'Kind of place: one of its active staff members does it (task 160)',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    type: String,
    example: 'strzyzenie',
    description:
      "Words in the salon's name or in one of its services' names; case and accents ignored (task 180b)",
  })
  @ApiQuery({
    name: 'city',
    required: false,
    type: String,
    example: 'Warszawa',
    description: "Part of the salon's city; case and accents ignored (task 180b)",
  })
  @ApiQuery({
    name: 'near',
    required: false,
    type: String,
    example: '52.2297,21.0122',
    description:
      'latitude,longitude: the nearest salons first, with distanceKm; salons without a place last (task 180b)',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1, minimum: 1 })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    type: Number,
    example: 12,
    minimum: 1,
    maximum: 50,
  })
  @ApiZodResponse(publicDirectorySchema)
  async list(
    @Req() req: AppRequest,
    @Query(new ZodValidationPipe(publicDirectoryQuerySchema)) query: PublicDirectoryQuery,
  ): Promise<PublicDirectoryResponse> {
    this.limiter.hit(`public:directory:ip:${req.ip}`, 120, 60_000);
    const chosen = query.language ?? [];
    const ids = await this.searchIds(query.q, query.city);
    const where = catalogueWhere(chosen, query.specialty, ids);
    // Task 180b: "W pobliżu" - the page is cut from all the salons found, nearest first.
    const near = query.near;
    const pageIds = near ? await this.nearestPage(where, near, query.page, query.pageSize) : null;
    const [total, locations, ...rest] = await this.prisma.$transaction([
      this.prisma.location.count({ where }),
      this.prisma.location.findMany({
        where: pageIds ? { id: { in: pageIds } } : where,
        select: {
          id: true,
          slug: true,
          name: true,
          addressLine: true,
          city: true,
          postalCode: true,
          languages: true,
          latitude: true,
          longitude: true,
          currency: true,
          photos: {
            where: { staffId: null },
            select: { id: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: 1,
          },
          staffMembers: {
            where: { active: true },
            select: {
              languages: true,
              specialties: true,
              services: {
                where: { service: { active: true } },
                select: { priceGrosze: true, service: { select: { priceGrosze: true } } },
              },
            },
          },
        },
        orderBy: [{ city: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        ...(pageIds ? {} : { skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      }),
      // Task 160: the numbers on the language and kind-of-place chips.
      ...SPOKEN.map((code) =>
        this.prisma.location.count({ where: catalogueWhere([code], query.specialty, ids) }),
      ),
      ...KINDS.map((kind) =>
        this.prisma.location.count({ where: catalogueWhere(chosen, kind, ids) }),
      ),
    ]);
    const counts = rest as number[];
    if (pageIds) {
      const order = new Map(pageIds.map((id, index) => [id, index]));
      locations.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    }
    return {
      items: locations.map(({ id: _id, staffMembers, languages, photos, ...salon }) => {
        const spoken = new Set([...languages, ...staffMembers.flatMap((s) => s.languages)]);
        // Task 91: what a client pays at least - a specialist's own price, else the service's.
        const prices = staffMembers
          .flatMap((s) => s.services.map((x) => x.priceGrosze ?? x.service.priceGrosze))
          .filter((price) => price > 0);
        return {
          ...salon,
          languages: SPOKEN.filter((code) => spoken.has(code)),
          priceFromGrosze: prices.length > 0 ? Math.min(...prices) : null,
          staffSpeaking:
            chosen.length > 0
              ? staffMembers.filter((s) => s.languages.some((code) => chosen.includes(code))).length
              : null,
          specialties: KINDS.filter((kind) =>
            staffMembers.some((s) => s.specialties.includes(kind)),
          ),
          photoUrl: photos[0] ? photoUrl(photos[0].id) : null,
          distanceKm:
            near && salon.latitude !== null && salon.longitude !== null
              ? distanceKm(near, { latitude: salon.latitude, longitude: salon.longitude })
              : null,
        };
      }),
      languageCounts: Object.fromEntries(SPOKEN.map((code, i) => [code, counts[i] ?? 0])) as Record<
        Language,
        number
      >,
      specialtyCounts: Object.fromEntries(
        KINDS.map((kind, i) => [kind, counts[SPOKEN.length + i] ?? 0]),
      ) as Record<Kind, number>,
      page: query.page,
      pageSize: query.pageSize,
      total,
      pageCount: Math.ceil(total / query.pageSize),
    };
  }

  /**
   * Task 180b: ids of the salons whose name or services match `q` and whose city matches `city`;
   * undefined without either. Done in code, not SQL, so accents are ignored the same way as in the
   * apps (no database extension); the catalogue holds bookable salons only, so the list stays small.
   */
  private async searchIds(q?: string, city?: string): Promise<string[] | undefined> {
    if (!q && !city) return undefined;
    const candidates = await this.prisma.location.findMany({
      where: catalogueWhere([]),
      select: {
        id: true,
        name: true,
        city: true,
        services: { where: { active: true }, select: { name: true } },
      },
    });
    return candidates
      .filter((salon) => !city || fold(salon.city).includes(fold(city)))
      .filter((salon) => !q || matchesSearch(q, [salon.name, ...salon.services.map((s) => s.name)]))
      .map((salon) => salon.id);
  }

  /** Task 180b: the ids of one page of the salons found, nearest first; unplaced ones last. */
  private async nearestPage(
    where: Prisma.LocationWhereInput,
    near: { latitude: number; longitude: number },
    page: number,
    pageSize: number,
  ): Promise<string[]> {
    const all = await this.prisma.location.findMany({
      where,
      select: { id: true, latitude: true, longitude: true },
      orderBy: [{ city: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
    const far = Number.POSITIVE_INFINITY;
    return all
      .map((salon, index) => ({
        id: salon.id,
        index,
        km:
          salon.latitude !== null && salon.longitude !== null
            ? distanceKm(near, { latitude: salon.latitude, longitude: salon.longitude })
            : far,
      }))
      .sort((a, b) => a.km - b.km || a.index - b.index)
      .slice((page - 1) * pageSize, page * pageSize)
      .map((salon) => salon.id);
  }
}
