import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { languageSchema } from '../common/enums.schemas';
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
    // Only salons a client can actually book: online booking on, with a service and a staff
    // member. A language matches when the salon or one of its active staff members speaks it.
    const bookable = {
      onlineBookingEnabled: true,
      services: { some: { active: true } },
      staffMembers: { some: { active: true } },
    };
    const where = query.language
      ? {
          ...bookable,
          OR: [
            { languages: { has: query.language } },
            { staffMembers: { some: { active: true, languages: { has: query.language } } } },
          ],
        }
      : bookable;
    const [total, locations] = await this.prisma.$transaction([
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
          staffMembers: {
            where: { active: true },
            select: {
              languages: true,
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
    ]);
    return {
      items: locations.map(({ staffMembers, languages, ...salon }) => {
        const spoken = new Set([...languages, ...staffMembers.flatMap((s) => s.languages)]);
        // Task 91: what a client pays at least - a specialist's own price, else the service's.
        const prices = staffMembers
          .flatMap((s) => s.services.map((x) => x.priceGrosze ?? x.service.priceGrosze))
          .filter((price) => price > 0);
        return {
          ...salon,
          languages: SPOKEN.filter((code) => spoken.has(code)),
          priceFromGrosze: prices.length > 0 ? Math.min(...prices) : null,
        };
      }),
      page: query.page,
      pageSize: query.pageSize,
      total,
      pageCount: Math.ceil(total / query.pageSize),
    };
  }
}
