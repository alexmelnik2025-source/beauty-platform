import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentAuth } from '../auth/decorators';
import { ApiZodBody, ApiZodResponse } from '../common/openapi';
import type { AuthContext } from '../common/request-context';
import {
  notificationListSchema,
  notificationsMarkedSchema,
  unreadCountSchema,
} from '../common/system.responses';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  listNotificationsSchema,
  markReadSchema,
  NotificationsService,
  type ListNotificationsQuery,
  type MarkReadInput,
  type NotificationResponse,
} from './notifications.service';

@ApiTags('me')
@ApiBearerAuth()
@Controller('me/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary: 'My notifications: new, cancelled and moved appointments (newest first)',
  })
  @ApiQuery({ name: 'unreadOnly', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({
    name: 'before',
    required: false,
    description: 'Id of the last item of the previous page',
  })
  @ApiZodResponse(notificationListSchema)
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listNotificationsSchema)) query: ListNotificationsQuery,
  ): Promise<NotificationResponse[]> {
    return this.notifications.list(auth.userId, query);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Number for the bell badge' })
  @ApiZodResponse(unreadCountSchema)
  unread(@CurrentAuth() auth: AuthContext): Promise<{ unread: number }> {
    return this.notifications.unreadCount(auth.userId);
  }

  @Post('read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark as read: {"ids": [...]} or {"all": true}' })
  @ApiZodBody(markReadSchema)
  @ApiZodResponse(notificationsMarkedSchema)
  markRead(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(markReadSchema)) body: MarkReadInput,
  ): Promise<{ updated: number }> {
    return this.notifications.markRead(auth.userId, body);
  }
}
