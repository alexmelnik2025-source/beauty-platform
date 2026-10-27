import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentAuth } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import { Idempotent } from '../common/idempotency.interceptor';
import { ApiZodBody, ApiZodResponse } from '../common/openapi';
import type { AuthContext, MembershipContext } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentMembership, MembershipGuard } from '../organizations/membership.guard';
import { timeBlockListSchema, timeBlockSchema } from './booking.responses';
import {
  createBlockSchema,
  listBlocksSchema,
  TimeBlocksService,
  updateBlockSchema,
  type CreateBlockInput,
  type ListBlocksQuery,
  type TimeBlockResponse,
  type UpdateBlockInput,
} from './time-blocks.service';

const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => notFound(what) });

@ApiTags('calendar')
@ApiBearerAuth()
@Controller('organizations/:orgId/locations/:locationId/time-blocks')
@UseGuards(MembershipGuard)
export class TimeBlocksController {
  constructor(private readonly blocks: TimeBlocksService) {}

  @Get()
  @ApiOperation({ summary: 'Time blocks between two local dates (max 42 days)' })
  @ApiQuery({ name: 'from', example: '2026-11-02' })
  @ApiQuery({ name: 'to', example: '2026-11-08' })
  @ApiQuery({ name: 'staffId', required: false })
  @ApiZodResponse(timeBlockListSchema)
  list(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Query(new ZodValidationPipe(listBlocksSchema)) query: ListBlocksQuery,
  ): Promise<TimeBlockResponse[]> {
    return this.blocks.list(m, auth.userId, locationId, query);
  }

  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Block time for one staff member or (staffId: null) the whole location',
    description:
      'Refused with 409 APPOINTMENTS_IN_THE_WAY when live appointments overlap (their ids are in details). Staff members need the blockOwnTime permission and may block only their own time.',
  })
  @ApiZodBody(createBlockSchema)
  @ApiZodResponse(timeBlockSchema, HttpStatus.CREATED)
  create(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Body(new ZodValidationPipe(createBlockSchema)) body: CreateBlockInput,
  ): Promise<TimeBlockResponse> {
    return this.blocks.create(m, auth.userId, locationId, body);
  }

  @Patch(':blockId')
  @ApiOperation({ summary: 'Move, resize or re-assign a block. Send the version you read' })
  @ApiZodBody(updateBlockSchema)
  @ApiZodResponse(timeBlockSchema)
  update(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('blockId', uuid('Time block')) blockId: string,
    @Body(new ZodValidationPipe(updateBlockSchema)) body: UpdateBlockInput,
  ): Promise<TimeBlockResponse> {
    return this.blocks.update(m, auth.userId, locationId, blockId, body);
  }

  @Delete(':blockId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a block; the time becomes free again' })
  remove(
    @CurrentAuth() auth: AuthContext,
    @CurrentMembership() m: MembershipContext,
    @Param('locationId', uuid('Location')) locationId: string,
    @Param('blockId', uuid('Time block')) blockId: string,
  ): Promise<void> {
    return this.blocks.remove(m, auth.userId, locationId, blockId);
  }
}
