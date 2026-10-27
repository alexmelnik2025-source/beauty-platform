import {
  Controller,
  Inject,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { isPlatformAdmin } from '../admin/platform-admin.guard';
import { notFound } from '../common/app-exception';
import { ApiZodResponse } from '../common/openapi';
import { APP_CONFIG, type AppConfig } from '../config/config';
import type { AuthContext } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import {
  meSchema,
  sessionListSchema,
  type MeResponse,
  type SessionResponse,
} from './auth.responses';
import { toPublicUser } from './auth.service';
import { CurrentAuth } from './decorators';

@ApiTags('me')
@ApiBearerAuth()
@Controller('me')
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The signed-in user and their organizations' })
  @ApiZodResponse(meSchema)
  async me(@CurrentAuth() auth: AuthContext): Promise<MeResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: auth.userId },
      include: {
        memberships: {
          where: { status: 'active' },
          include: { organization: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    return {
      user: toPublicUser(user),
      organizations: user.memberships.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        role: m.role,
      })),
      isPlatformAdmin: isPlatformAdmin(this.config, user),
    };
  }

  @Get('sessions')
  @ApiOperation({ summary: 'Devices where the user is signed in' })
  @ApiZodResponse(sessionListSchema)
  async sessions(@CurrentAuth() auth: AuthContext): Promise<SessionResponse[]> {
    const sessions = await this.prisma.session.findMany({
      where: { userId: auth.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
    });
    return sessions.map((s) => ({
      id: s.id,
      clientType: s.clientType,
      deviceName: s.deviceName,
      userAgent: s.userAgent,
      createdAt: s.createdAt.toISOString(),
      lastUsedAt: s.lastUsedAt.toISOString(),
      current: s.id === auth.sessionId,
    }));
  }

  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Sign out a device' })
  async revokeSession(
    @CurrentAuth() auth: AuthContext,
    @Param('sessionId', new ParseUUIDPipe({ exceptionFactory: () => notFound('Session') }))
    sessionId: string,
  ): Promise<void> {
    const result = await this.prisma.session.updateMany({
      where: { id: sessionId, userId: auth.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) {
      throw notFound('Session');
    }
  }
}
