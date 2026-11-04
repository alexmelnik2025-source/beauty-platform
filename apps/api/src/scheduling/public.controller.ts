import { wishQuestions } from '../booking/visit-wishes';
import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ApiZodResponse } from '../common/openapi';
import { Public } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import { RateLimiterService } from '../common/rate-limiter.service';
import type { AppRequest } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { Location } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { durationRange, priceRange } from './staff-prices';
import { SmsService } from '../sms/sms.service';
import { AvailabilityService } from './availability.service';
import { photoUrl } from './photos.service';
import {
  availabilitySchema,
  publicLegalTextsSchema,
  publicLocationSchema,
  type AvailabilityResponse,
  type OpeningDay,
  type PublicLegalTextsResponse,
  type PublicLocationResponse,
} from './public.responses';
import { availabilityQuerySchema, type AvailabilityQuery } from './scheduling.schemas';
import { formatClock } from './time';

/**
 * Opening hours as the client sees them: for each weekday, the union of the regular weekly
 * hours of the listed staff (overlapping and touching intervals are merged).
 */
export function openingHours(
  rows: { weekday: number; startMinute: number; endMinute: number }[],
): OpeningDay[] {
  return [1, 2, 3, 4, 5, 6, 7].map((weekday) => {
    const day = rows
      .filter((r) => r.weekday === weekday && r.endMinute > r.startMinute)
      .sort((a, b) => a.startMinute - b.startMinute);
    const merged: { start: number; end: number }[] = [];
    for (const r of day) {
      const last = merged.at(-1);
      if (last && r.startMinute <= last.end) {
        last.end = Math.max(last.end, r.endMinute);
      } else {
        merged.push({ start: r.startMinute, end: r.endMinute });
      }
    }
    return {
      weekday,
      intervals: merged.map((i) => ({ start: formatClock(i.start), end: formatClock(i.end) })),
    };
  });
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
    private readonly sms: SmsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Salon page: address, description, opening hours, services with prices, staff',
  })
  @ApiZodResponse(publicLocationSchema)
  async get(@Req() req: AppRequest, @Param('slug') slug: string): Promise<PublicLocationResponse> {
    this.limiter.hit(`public:ip:${req.ip}`, 300, 60_000);
    const location = await this.findBookable(slug);
    const staff = await this.prisma.staffMember.findMany({
      where: { locationId: location.id, active: true },
      include: {
        services: {
          where: { service: { active: true } },
          select: { serviceId: true, priceGrosze: true, durationMinutes: true },
        },
        workingHours: { select: { weekday: true, startMinute: true, endMinute: true } },
        photo: { select: { id: true } },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const listed = staff.filter((s) => s.services.length > 0);
    const offered = new Set(staff.flatMap((s) => s.services.map((x) => x.serviceId)));
    const services = await this.prisma.service.findMany({
      where: { locationId: location.id, active: true, id: { in: [...offered] } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const used = new Set(
      services.map((s) => s.categoryId).filter((id): id is string => id !== null),
    );
    const categories = await this.prisma.serviceCategory.findMany({
      where: { locationId: location.id, id: { in: [...used] } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    const photos = await this.prisma.photo.findMany({
      where: { locationId: location.id, staffId: null },
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const basePrice = new Map(services.map((s) => [s.id, s.priceGrosze]));
    const baseDuration = new Map(services.map((s) => [s.id, s.durationMinutes]));
    return {
      slug: location.slug,
      name: location.name,
      addressLine: location.addressLine,
      city: location.city,
      postalCode: location.postalCode,
      phone: location.phone,
      timezone: location.timezone,
      currency: location.currency,
      defaultLocale: location.defaultLocale,
      languages: location.languages,
      description: location.description,
      openingHours: openingHours(listed.flatMap((s) => s.workingHours)),
      photos: photos.map((p) => ({ id: p.id, url: photoUrl(p.id) })),
      wishQuestions: wishQuestions(location),
      codeChannels: this.sms.available ? ['email', 'sms'] : ['email'],
      categories: categories.map((c) => ({ id: c.id, name: c.name })),
      services: services.map((s) => {
        // Tasks 62 and 70: a specialist's own price and duration, else the service's.
        const links = listed.flatMap((m) => m.services.filter((x) => x.serviceId === s.id));
        const range = priceRange(
          s.priceGrosze,
          links.map((x) => x.priceGrosze),
        );
        const minutes = durationRange(
          s.durationMinutes,
          links.map((x) => x.durationMinutes),
        );
        return {
          id: s.id,
          categoryId: s.categoryId,
          name: s.name,
          description: s.description,
          durationMinutes: s.durationMinutes,
          priceGrosze: s.priceGrosze,
          priceFromGrosze: range.fromGrosze,
          priceToGrosze: range.toGrosze,
          durationFromMinutes: minutes.fromMinutes,
          durationToMinutes: minutes.toMinutes,
          wishPhotos: s.wishPhotos,
        };
      }),
      staff: listed.map((s) => ({
        id: s.id,
        displayName: s.displayName,
        bio: s.bio,
        languages: s.languages,
        specialties: s.specialties,
        customSpecialty: s.customSpecialty,
        serviceIds: s.services.map((x) => x.serviceId).sort(),
        prices: s.services
          .map((x) => ({
            serviceId: x.serviceId,
            priceGrosze: x.priceGrosze ?? basePrice.get(x.serviceId) ?? 0,
            durationMinutes: x.durationMinutes ?? baseDuration.get(x.serviceId) ?? 0,
          }))
          .sort((a, b) => a.serviceId.localeCompare(b.serviceId)),
        photoUrl: s.photo ? photoUrl(s.photo.id) : null,
      })),
    };
  }

  @Get('legal')
  @ApiOperation({
    summary: 'Booking terms and privacy policy of the salon',
    description: 'Linked from the consent checkbox of the booking form.',
  })
  @ApiZodResponse(publicLegalTextsSchema)
  async legal(
    @Req() req: AppRequest,
    @Param('slug') slug: string,
  ): Promise<PublicLegalTextsResponse> {
    this.limiter.hit(`public:ip:${req.ip}`, 300, 60_000);
    const location = await this.findBookable(slug);
    return {
      name: location.name,
      bookingTerms: location.bookingTerms,
      privacyPolicy: location.privacyPolicy,
      updatedAt: location.updatedAt.toISOString(),
    };
  }

  @Get('availability')
  @ApiOperation({
    summary: 'Free start times for clients',
    description:
      "The salon's minimum lead time and booking horizon apply. Max 31 days per request.",
  })
  @ApiQuery({ name: 'serviceId', required: true })
  @ApiQuery({ name: 'staffId', required: false, description: 'Omit for "any staff member"' })
  @ApiQuery({
    name: 'staffIds',
    required: false,
    description: 'Task 70: "any of these" specialists, comma-separated (ignored with staffId)',
  })
  @ApiQuery({ name: 'from', required: true, example: '2026-11-02' })
  @ApiQuery({ name: 'to', required: true, example: '2026-11-08' })
  @ApiZodResponse(availabilitySchema)
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
