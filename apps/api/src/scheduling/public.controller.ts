import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import { RateLimiterService } from '../common/rate-limiter.service';
import type { AppRequest } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { Location } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AvailabilityService, type AvailabilityResponse } from './availability.service';
import { availabilityQuerySchema, type AvailabilityQuery } from './scheduling.schemas';

export interface PublicLocationResponse {
  slug: string;
  name: string;
  addressLine: string;
  city: string;
  postalCode: string;
  phone: string | null;
  timezone: string;
  defaultLocale: string;
  services: {
    id: string;
    name: string;
    description: string | null;
    durationMinutes: number;
    priceGrosze: number;
  }[];
  staff: { id: string; displayName: string; bio: string | null; serviceIds: string[] }[];
}

/**
 * What the public booking page (/b/<slug>) and the client app see. Only locations
 * with online booking switched on; only active services that someone performs.
 * Internal details (buffers, staff accounts, organization) are never exposed.
 */
@ApiTags('public')
@Public()
@Controller('public/locations/:slug')
export class PublicLocationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly limiter: RateLimiterService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Salon page: address, services with prices, staff' })
  async get(@Req() req: AppRequest, @Param('slug') slug: string): Promise<PublicLocationResponse> {
    this.limiter.hit(`public:ip:${req.ip}`, 300, 60_000);
    const location = await this.findBookable(slug);
    const staff = await this.prisma.staffMember.findMany({
      where: { locationId: location.id, active: true },
      include: { services: { where: { service: { active: true } }, select: { serviceId: true } } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const offered = new Set(staff.flatMap((s) => s.services.map((x) => x.serviceId)));
    const services = await this.prisma.service.findMany({
      where: { locationId: location.id, active: true, id: { in: [...offered] } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return {
      slug: location.slug,
      name: location.name,
      addressLine: location.addressLine,
      city: location.city,
      postalCode: location.postalCode,
      phone: location.phone,
      timezone: location.timezone,
      defaultLocale: location.defaultLocale,
      services: services.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        durationMinutes: s.durationMinutes,
        priceGrosze: s.priceGrosze,
      })),
      staff: staff
        .filter((s) => s.services.length > 0)
        .map((s) => ({
          id: s.id,
          displayName: s.displayName,
          bio: s.bio,
          serviceIds: s.services.map((x) => x.serviceId).sort(),
        })),
    };
  }

  @Get('availability')
  @ApiOperation({
    summary: 'Free start times for clients',
    description: "The salon's minimum lead time and booking horizon apply. Max 31 days per request.",
  })
  @ApiQuery({ name: 'serviceId', required: true })
  @ApiQuery({ name: 'staffId', required: false, description: 'Omit for "any staff member"' })
  @ApiQuery({ name: 'from', required: true, example: '2026-11-02' })
  @ApiQuery({ name: 'to', required: true, example: '2026-11-08' })
  async availabilityFor(
    @Req() req: AppRequest,
    @Param('slug') slug: string,
    @Query(new ZodValidationPipe(availabilityQuerySchema)) query: AvailabilityQuery,
  ): Promise<AvailabilityResponse> {
    this.limiter.hit(`public:ip:${req.ip}`, 300, 60_000);
    return this.availability.forPublic(await this.findBookable(slug), query);
  }

  private async findBookable(slug: string): Promise<Location> {
    const location = await this.prisma.location.findUnique({ where: { slug: slug.toLowerCase() } });
    if (!location || !location.onlineBookingEnabled) {
      throw notFound('Salon');
    }
    return location;
  }
}
