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
function catalogueWhere(language?: Language, specialty?: Kind): Prisma.LocationWhereInput {
  const and: Prisma.LocationWhereInput[] = [
    {
      onlineBookingEnabled: true,
      services: { some: { active: true } },
      staffMembers: { some: { active: true } },
    },
  ];
  if (language) {
    and.push({
      OR: [
        { languages: { has: language } },
        { staffMembers: { some: { active: true, languages: { has: language } } } },
      ],
    });
  }
  if (specialty) {
    and.push({ staffMembers: { some: { active: true, specialties: { has: specialty } } } });
  }
  return { AND: and };
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
    enum: SPOKEN,
    description: 'Spoken by the salon or by one of its staff members',
  })
  @ApiQuery({
    name: 'specialty',
    required: false,
    enum: KINDS,
    description: 'Kind of place: one of its active staff members does it (task 160)',
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
    const where = catalogueWhere(query.language, query.specialty);
    const [total, locations, ...rest] = await this.prisma.$transaction([
      this.prisma.location.count({ where }),
      this.prisma.location.findMany({
        where,
        select: {
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
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      // Task 160: the numbers on the language and kind-of-place chips.
      ...SPOKEN.map((code) =>
        this.prisma.location.count({ where: catalogueWhere(code, query.specialty) }),
      ),
      ...KINDS.map((kind) =>
        this.prisma.location.count({ where: catalogueWhere(query.language, kind) }),
      ),
    ]);
    const counts = rest as number[];
    return {
      items: locations.map(({ staffMembers, languages, photos, ...salon }) => {
        const spoken = new Set([...languages, ...staffMembers.flatMap((s) => s.languages)]);
        // Task 91: what a client pays at least - a specialist's own price, else the service's.
        const prices = staffMembers
          .flatMap((s) => s.services.map((x) => x.priceGrosze ?? x.service.priceGrosze))
          .filter((price) => price > 0);
        return {
          ...salon,
          languages: SPOKEN.filter((code) => spoken.has(code)),
          priceFromGrosze: prices.length > 0 ? Math.min(...prices) : null,
          staffSpeaking: query.language
            ? staffMembers.filter((s) => s.languages.includes(query.language!)).length
            : null,
          specialties: KINDS.filter((kind) =>
            staffMembers.some((s) => s.specialties.includes(kind)),
          ),
          photoUrl: photos[0] ? photoUrl(photos[0].id) : null,
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
}
