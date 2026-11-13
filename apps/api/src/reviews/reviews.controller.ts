import {
  applyDecorators,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
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
  salonReviewSchema,
  salonReviewsSchema,
  visitReviewSchema,
  type PublicReviewsResponse,
  type ReviewSettingsResponse,
  type SalonReviewResponse,
  type SalonReviewsResponse,
  type VisitReviewResponse,
} from './reviews.responses';
import {
  exportReviewsQuerySchema,
  listReviewsQuerySchema,
  salonReviewsQuerySchema,
  replyReviewSchema,
  updateReviewSettingsSchema,
  writeReviewSchema,
  type ExportReviewsQuery,
  type ListReviewsQuery,
  type SalonReviewsQuery,
  type ReplyReviewInput,
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
    ApiQuery({
      name: 'rating',
      required: false,
      type: Number,
      description:
        'Task 380: only reviews with this many stars (1-5); count, average and stars stay',
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
  @ApiQuery({
    name: 'serviceId',
    required: false,
    description: 'Task 420: only reviews of visits for this service',
  })
  @pageQueries()
  @ApiQuery({
    name: 'unanswered',
    required: false,
    enum: ['true', 'false'],
    description: 'Task 382: "Bez odpowiedzi" - only reviews the salon has not answered yet',
  })
  @ApiZodResponse(salonReviewsSchema)
  list(
    @CurrentMembership() m: MembershipContext,
    @CurrentAuth() auth: AuthContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Query(new ZodValidationPipe(salonReviewsQuerySchema)) query: SalonReviewsQuery,
  ): Promise<SalonReviewsResponse> {
    return this.reviews.listForSalon(m, auth.userId, locationId, query);
  }

  @Get('reviews/export.csv')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: 'The reviews as a CSV file (owners and managers)',
    description:
      'Task 385. The list’s filters (staffId, serviceId, rating, unanswered); newest first. Semicolon-separated, UTF-8 with a byte order mark (opens in Excel). Written to the audit log.',
  })
  @ApiQuery({ name: 'serviceId', required: false, description: 'Task 420: only this service' })
  @ApiQuery({ name: 'staffId', required: false, description: 'Only reviews of this specialist' })
  @ApiQuery({ name: 'rating', required: false, type: Number, description: 'Only this many stars' })
  @ApiQuery({ name: 'unanswered', required: false, enum: ['true', 'false'] })
  @ApiQuery({ name: 'lang', required: false, enum: ['pl', 'uk', 'ru', 'en'] })
  @ApiProduces('text/csv')
  @ApiOkResponse({ description: 'The CSV file', schema: { type: 'string' } })
  async exportCsv(
    @CurrentMembership() m: MembershipContext,
    @CurrentAuth() auth: AuthContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Query(new ZodValidationPipe(exportReviewsQuerySchema)) query: ExportReviewsQuery,
    @Res() res: Response,
  ): Promise<void> {
    const csv = await this.reviews.exportCsv(m, auth.userId, locationId, query);
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="opinie-${day}.csv"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(csv);
  }

  @Put('reviews/:reviewId/reply')
  @RequireRoles('owner', 'manager')
  @ApiOperation({
    summary: 'Answer a review publicly (or change the answer)',
    description:
      'Task 211. Shown under the review on the salon page and to the client. Owners and managers only.',
  })
  @ApiZodBody(replyReviewSchema)
  @ApiZodResponse(salonReviewSchema)
  reply(
    @CurrentMembership() m: MembershipContext,
    @CurrentAuth() auth: AuthContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('reviewId', uuid('Review')) reviewId: string,
    @Body(new ZodValidationPipe(replyReviewSchema)) body: ReplyReviewInput,
  ): Promise<SalonReviewResponse> {
    return this.reviews.reply(m, auth.userId, locationId, reviewId, body);
  }

  @Delete('reviews/:reviewId/reply')
  @RequireRoles('owner', 'manager')
  @ApiOperation({ summary: 'Remove the salon’s answer under a review' })
  @ApiZodResponse(salonReviewSchema)
  removeReply(
    @CurrentMembership() m: MembershipContext,
    @CurrentAuth() auth: AuthContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('reviewId', uuid('Review')) reviewId: string,
  ): Promise<SalonReviewResponse> {
    return this.reviews.removeReply(m, auth.userId, locationId, reviewId);
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
