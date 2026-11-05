import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { notFound } from '../common/app-exception';
import { ApiZodBody, ApiZodResponse } from '../common/openapi';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { visitReviewSchema, type VisitReviewResponse } from '../reviews/reviews.responses';
import { writeReviewSchema, type WriteReviewInput } from '../reviews/reviews.schemas';
import { ReviewsService } from '../reviews/reviews.service';
import { ClientGuard, CurrentClient } from './client-auth';
import type { ClientAuth } from './client.service';

const idPipe = new ParseUUIDPipe({ exceptionFactory: () => notFound('Appointment') });

/** Task 165b: the client's review of one of their visits, in the client app and "Moje wizyty". */
@ApiTags('client app')
@Public()
@UseGuards(ClientGuard)
@ApiBearerAuth()
@Controller('client/appointments/:id/review')
export class ClientReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  @ApiOperation({ summary: 'My review of this visit and whether I can (still) write it' })
  @ApiZodResponse(visitReviewSchema)
  get(
    @CurrentClient() client: ClientAuth,
    @Param('id', idPipe) id: string,
  ): Promise<VisitReviewResponse> {
    return this.reviews.getForClient(client.email, id);
  }

  @Put()
  @ApiOperation({
    summary: 'Write or change my review of this visit (1–5 stars, optional words)',
    description:
      '409 REVIEW_NOT_POSSIBLE when the salon does not collect reviews, the visit has not taken place, or it ended more than 30 days ago.',
  })
  @ApiZodBody(writeReviewSchema)
  @ApiZodResponse(visitReviewSchema)
  write(
    @CurrentClient() client: ClientAuth,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(writeReviewSchema)) body: WriteReviewInput,
  ): Promise<VisitReviewResponse> {
    return this.reviews.writeForClient(client.email, id, body);
  }
}
