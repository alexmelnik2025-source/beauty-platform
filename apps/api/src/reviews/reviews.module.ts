import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { PublicReviewsController, ReviewsController } from './reviews.controller';
import { ReviewRequestService } from './review-request.service';
import { ReviewsService } from './reviews.service';

/** Task 165b: reviews after the visit. */
@Module({
  imports: [OrganizationsModule],
  controllers: [ReviewsController, PublicReviewsController],
  providers: [ReviewsService, ReviewRequestService],
  exports: [ReviewsService, ReviewRequestService],
})
export class ReviewsModule {}
