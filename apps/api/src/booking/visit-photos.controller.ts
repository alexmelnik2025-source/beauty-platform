import {
  applyDecorators,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentAuth, Public } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import { ApiZodResponse } from '../common/openapi';
import { RateLimiterService } from '../common/rate-limiter.service';
import type { AppRequest, AuthContext, MembershipContext } from '../common/request-context';
import { CurrentMembership, MembershipGuard } from '../organizations/membership.guard';
import {
  visitPhotoListSchema,
  visitPhotoSchema,
  type VisitPhotoListResponse,
  type VisitPhotoResponse,
} from './visit-photos.responses';
import { MAX_VISIT_PHOTOS, VisitPhotosService } from './visit-photos.service';

const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => notFound(what) });
const MINUTE = 60_000;
const HOLD_TOKEN = 'x-hold-token';

const ImageBody = () =>
  applyDecorators(
    ApiConsumes('image/jpeg', 'image/png', 'image/webp'),
    ApiBody({
      description: 'The picture itself (not a form), at most 3 MB; the app shrinks it first',
      schema: { type: 'string', format: 'binary' },
    }),
  );
const HoldTokenHeader = () =>
  ApiHeader({ name: 'X-Hold-Token', required: true, description: 'The holdToken of the hold' });

/** Task 80b: "Pokaż, co chcesz" — the client's example photos while booking and by the visit link. */
@ApiTags('public booking')
@Public()
@Controller('public')
export class PublicVisitPhotosController {
  constructor(
    private readonly photos: VisitPhotosService,
    private readonly limiter: RateLimiterService,
  ) {}

  @Post('holds/:holdId/photos')
  @ApiOperation({
    summary: `Add an example photo to the held time (at most ${MAX_VISIT_PHOTOS})`,
    description:
      '409 PHOTOS_NOT_ASKED: the salon does not ask for photos for this service; 409 TOO_MANY_PHOTOS; ' +
      '410 HOLD_EXPIRED; 413 PHOTO_TOO_LARGE; 415 UNSUPPORTED_PHOTO.',
  })
  @HoldTokenHeader()
  @ImageBody()
  @ApiZodResponse(visitPhotoSchema, HttpStatus.CREATED)
  add(
    @Req() req: AppRequest,
    @Param('holdId', uuid('Hold')) holdId: string,
    @Headers(HOLD_TOKEN) holdToken: string,
  ): Promise<VisitPhotoResponse> {
    this.limiter.hit(`visit-photo:ip:${req.ip}`, 30, 10 * MINUTE);
    return this.photos.addToHold(holdId, holdToken, req);
  }

  @Get('holds/:holdId/photos')
  @ApiOperation({ summary: 'The example photos added to the held time' })
  @HoldTokenHeader()
  @ApiZodResponse(visitPhotoListSchema)
  listForHold(
    @Param('holdId', uuid('Hold')) holdId: string,
    @Headers(HOLD_TOKEN) holdToken: string,
  ): Promise<VisitPhotoListResponse> {
    return this.photos.listForHold(holdId, holdToken);
  }

  @Delete('holds/:holdId/photos/:photoId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove an example photo from the held time' })
  @HoldTokenHeader()
  removeFromHold(
    @Param('holdId', uuid('Hold')) holdId: string,
    @Param('photoId', uuid('Photo')) photoId: string,
    @Headers(HOLD_TOKEN) holdToken: string,
  ): Promise<void> {
    return this.photos.removeFromHold(holdId, holdToken, photoId);
  }

  @Get('appointments/:token/photos')
  @ApiOperation({ summary: 'The example photos of the visit (by the link from the email)' })
  @ApiZodResponse(visitPhotoListSchema)
  listByLink(
    @Req() req: AppRequest,
    @Param('token') token: string,
  ): Promise<VisitPhotoListResponse> {
    this.limiter.hit(`manage:ip:${req.ip}`, 60, 10 * MINUTE);
    return this.photos.listByManageToken(token);
  }

  @Delete('appointments/:token/photos/:photoId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove an example photo before the visit',
    description: '409 TOO_LATE_TO_CHANGE once the visit has started.',
  })
  removeByLink(
    @Req() req: AppRequest,
    @Param('token') token: string,
    @Param('photoId', uuid('Photo')) photoId: string,
  ): Promise<void> {
    this.limiter.hit(`manage:ip:${req.ip}`, 60, 10 * MINUTE);
    return this.photos.removeByManageToken(token, photoId);
  }

  @Get('visit-photos/:photoId')
  @ApiOperation({
    summary: 'The picture behind a signed link (valid for an hour)',
    description: 'Links come from the photo lists; an expired or changed link is 404.',
  })
  async file(
    @Req() req: AppRequest,
    @Param('photoId', uuid('Photo')) photoId: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Res() res: Response,
  ): Promise<void> {
    this.limiter.hit(`public:photo:ip:${req.ip}`, 1200, MINUTE);
    const photo = await this.photos.file(photoId, exp, sig);
    res.setHeader('Content-Type', photo.contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.end(Buffer.from(photo.data));
  }
}

/** Task 80b: the client's example photos in the visit card (cabinet and business app). */
@ApiTags('appointments')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId/appointments/:appointmentId/photos')
@UseGuards(MembershipGuard)
export class AppointmentPhotosController {
  constructor(private readonly photos: VisitPhotosService) {}

  @Get()
  @ApiOperation({
    summary: "The client's example photos for the visit",
    description: 'Seen by whoever may open the visit (like its note); deleted 90 days after it.',
  })
  @ApiZodResponse(visitPhotoListSchema)
  list(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('appointmentId', uuid('Appointment')) appointmentId: string,
  ): Promise<VisitPhotoListResponse> {
    return this.photos.listForStaff(m, auth.userId, locationId, appointmentId);
  }
}
