import {
  applyDecorators,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentAuth, Public } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import { ApiZodResponse } from '../common/openapi';
import { RateLimiterService } from '../common/rate-limiter.service';
import type { AppRequest, AuthContext, MembershipContext } from '../common/request-context';
import { photoListSchema, photoSchema } from '../common/system.responses';
import {
  CurrentMembership,
  MembershipGuard,
  RequireRoles,
} from '../organizations/membership.guard';
import { MAX_SALON_PHOTOS, PhotosService, type PhotoResponse } from './photos.service';

const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => notFound(what) });

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ImageBody = () =>
  applyDecorators(
    ApiConsumes(...IMAGE_TYPES),
    ApiBody({
      description: 'The picture itself (not a form), at most 3 MB',
      schema: { type: 'string', format: 'binary' },
    }),
  );

@ApiTags('photos')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId/photos')
@UseGuards(MembershipGuard)
export class LocationPhotosController {
  constructor(private readonly photos: PhotosService) {}

  @Get()
  @ApiOperation({ summary: 'Salon photos for the booking page, oldest first' })
  @ApiZodResponse(photoListSchema)
  list(
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
  ): Promise<PhotoResponse[]> {
    return this.photos.listSalonPhotos(m, locationId);
  }

  @Post()
  @RequireRoles('owner', 'manager')
  @ApiOperation({ summary: `Add a salon photo (JPEG, PNG or WebP; at most ${MAX_SALON_PHOTOS})` })
  @ImageBody()
  @ApiZodResponse(photoSchema, HttpStatus.CREATED)
  add(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Req() req: AppRequest,
  ): Promise<PhotoResponse> {
    return this.photos.addSalonPhoto(m, auth.userId, locationId, req);
  }

  @Delete(':photoId')
  @RequireRoles('owner', 'manager')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a salon photo' })
  remove(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('photoId', uuid('Photo')) photoId: string,
  ): Promise<void> {
    return this.photos.removeSalonPhoto(m, auth.userId, locationId, photoId);
  }
}

@ApiTags('photos')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId/staff/:staffId/photo')
@UseGuards(MembershipGuard)
export class StaffPhotoController {
  constructor(private readonly photos: PhotosService) {}

  @Put()
  @RequireRoles('owner', 'manager')
  @ApiOperation({ summary: "Set the staff member's photo (replaces the old one)" })
  @ImageBody()
  @ApiZodResponse(photoSchema)
  set(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('staffId', uuid('Staff member')) staffId: string,
    @Req() req: AppRequest,
  ): Promise<PhotoResponse> {
    return this.photos.setStaffPhoto(m, auth.userId, locationId, staffId, req);
  }

  @Delete()
  @RequireRoles('owner', 'manager')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Remove the staff member's photo" })
  remove(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('staffId', uuid('Staff member')) staffId: string,
  ): Promise<void> {
    return this.photos.removeStaffPhoto(m, auth.userId, locationId, staffId);
  }
}

/** The pictures themselves, for <img> on the booking page, in the client app and the cabinet. */
@ApiTags('public')
@Public()
@Controller('public/photos')
export class PublicPhotosController {
  constructor(
    private readonly photos: PhotosService,
    private readonly limiter: RateLimiterService,
  ) {}

  @Get(':photoId')
  @ApiOperation({
    summary: 'A salon or staff photo',
    description: 'A new photo always gets a new link, so browsers may keep it for a year.',
  })
  async get(
    @Req() req: AppRequest,
    @Param('photoId', uuid('Photo')) photoId: string,
    @Res() res: Response,
  ): Promise<void> {
    this.limiter.hit(`public:photo:ip:${req.ip}`, 1200, 60_000);
    const photo = await this.photos.file(photoId);
    res.setHeader('Content-Type', photo.contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.end(Buffer.from(photo.data));
  }
}
