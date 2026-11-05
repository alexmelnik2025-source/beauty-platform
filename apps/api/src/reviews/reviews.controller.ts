import {
  applyDecorators,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentAuth, Public } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import { ApiZodBody, ApiZodResponse } from '../common/openapi';
import { RateLimiterService } from '../common/rate-limiter.service';
import type { AppRequest, AuthContext, MembershipContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  CurrentMembership,
  MembershipGuard,
  RequireRoles,
} from '../organizations/membership.guard';
import {
  publicReviewsSchema,
  reviewSettingsSchema,
  salonReviewsSchema,
  visitReviewSchema,
  type PublicReviewsResponse,
  type ReviewSettingsResponse,
  type SalonReviewsResponse,
  type VisitReviewResponse,
} from './reviews.responses';
import {
  listReviewsQuerySchema,
  updateReviewSettingsSchema,
  writeReviewSchema,
  type ListReviewsQuery,
  type UpdateReviewSettingsInput,
  type WriteReviewInput,
} from './reviews.schemas';
import { ReviewsService } from './reviews.service';

const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => notFound(what) });
const MINUTE = 60_000;

const pageQueries = () =>
  applyDecorators(
    ApiQuery({ name: 'staffId', required: false, description: 'Only reviews of this specialist' }),
    ApiQuery({
      name: 'before',
      required: false,
      description: 'Next page: nextBefore of the previous page',
    }),
  );

/** Task 165b: the salon's review settings and its reviews in the cabinet. */
@ApiTags('reviews')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId')
@UseGuards(MembershipGuard)
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get('review-settings')
  @RequireRoles('owner', 'manager')
  @ApiOperation({ summary: 'Review settings of the location (off until the salon saves them)' })
  @ApiZodResponse(reviewSettingsSchema)
  getSettings(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
  ): Promise<ReviewSettingsResponse> {
    return this.reviews.getSettings(m, locationId);
  }

  @Put('review-settings')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: 'Switch reviews on or off and set when the client is asked',
    description:
      'version: 0 before the first save; 409 VERSION_CONFLICT when someone saved first. Switching off hides the reviews from the salon page (they are kept).',
  })
  @ApiZodBody(updateReviewSettingsSchema)
  @ApiZodResponse(reviewSettingsSchema)
  updateSettings(
    @CurrentMembership() m: MembershipContext,
    @CurrentAuth() auth: AuthContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Body(new ZodValidationPipe(updateReviewSettingsSchema)) body: UpdateReviewSettingsInput,
  ): Promise<ReviewSettingsResponse> {
    return this.reviews.updateSettings(m, auth.userId, locationId, body);
  }

  @Get('reviews')
  @ApiOperation({
    summary: 'Reviews of the location, newest first (20 per page)',
    description:
      'With the client’s name. Staff without “all appointments” see only reviews of their own visits.',
  })
  @pageQueries()
  @ApiZodResponse(salonReviewsSchema)
  list(
    @CurrentMembership() m: MembershipContext,
    @CurrentAuth() auth: AuthContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Query(new ZodValidationPipe(listReviewsQuerySchema)) query: ListReviewsQuery,
  ): Promise<SalonReviewsResponse> {
    return this.reviews.listForSalon(m, auth.userId, locationId, query);
  }
}

/** Task 165b: reviews on the salon page and the client's review by the "manage" link. */
@ApiTags('public')
@Public()
@Controller('public')
export class PublicReviewsController {
  constructor(
    private readonly reviews: ReviewsService,
    private readonly limiter: RateLimiterService,
  ) {}

  @Get('locations/:slug/reviews')
  @ApiOperation({
    summary: 'Reviews on the salon page, newest first (20 per page), without client data',
    description: 'enabled=false and nothing else while the salon does not collect reviews.',
  })
  @pageQueries()
  @ApiZodResponse(publicReviewsSchema)
  list(
    @Req() req: AppRequest,
    @Param('slug') slug: string,
    @Query(new ZodValidationPipe(listReviewsQuerySchema)) query: ListReviewsQuery,
  ): Promise<PublicReviewsResponse> {
    this.limiter.hit(`public:ip:${req.ip}`, 300, MINUTE);
    return this.reviews.listPublic(slug, query);
  }

  @Get('appointments/:token/review')
  @ApiOperation({ summary: 'The client’s review of the visit behind a "manage" link' })
  @ApiZodResponse(visitReviewSchema)
  get(@Req() req: AppRequest, @Param('token') token: string): Promise<VisitReviewResponse> {
    this.limiter.hit(`manage:ip:${req.ip}`, 60, 10 * MINUTE);
    return this.reviews.getByToken(token);
  }

  @Put('appointments/:token/review')
  @ApiOperation({
    summary: 'Write or change the review of the visit (1–5 stars, optional words)',
    description:
      '409 REVIEW_NOT_POSSIBLE when the salon does not collect reviews, the visit has not taken place, or it ended more than 30 days ago.',
  })
  @ApiZodBody(writeReviewSchema)
  @ApiZodResponse(visitReviewSchema)
  write(
    @Req() req: AppRequest,
    @Param('token') token: string,
    @Body(new ZodValidationPipe(writeReviewSchema)) body: WriteReviewInput,
  ): Promise<VisitReviewResponse> {
    this.limiter.hit(`manage:ip:${req.ip}`, 60, 10 * MINUTE);
    return this.reviews.writeByToken(token, body);
  }
}
