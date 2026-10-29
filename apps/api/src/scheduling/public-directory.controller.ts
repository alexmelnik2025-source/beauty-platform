import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
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
    summary: 'Public paginated salon directory; returns no organization or staff data',
  })
  @ApiQuery({ name: 'language', required: false, enum: ['pl', 'uk', 'ru', 'be', 'en'] })
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
    const where = {
      onlineBookingEnabled: true,
      ...(query.language ? { languages: { has: query.language } } : {}),
    };
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
        },
        orderBy: [{ city: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: locations,
      page: query.page,
      pageSize: query.pageSize,
      total,
      pageCount: Math.ceil(total / query.pageSize),
    };
  }
}
