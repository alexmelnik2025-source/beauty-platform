import { Controller, Get, Param, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { ApiZodResponse } from '../common/openapi';
import { RateLimiterService } from '../common/rate-limiter.service';
import type { AppRequest } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  giftVoucherCodeSchema,
  publicGiftVoucherSchema,
  type PublicGiftVoucherResponse,
} from './vouchers.schemas';
import { VouchersService } from './vouchers.service';

const HOUR = 60 * 60 * 1000;

/**
 * Task 536: "Sprawdź bon" — on the salon page and in the client app anyone with the code sees
 * what the voucher is worth, what is left and until when. Nothing else about it (who it is for,
 * the note, the payments) leaves the salon. Few tries per hour from one address, so codes cannot
 * be guessed.
 */
@ApiTags('public')
@Public()
@Controller('public/locations/:slug/gift-vouchers')
export class PublicVouchersController {
  constructor(
    private readonly vouchers: VouchersService,
    private readonly limiter: RateLimiterService,
  ) {}

  @Get(':code')
  @ApiOperation({
    summary: '"Sprawdź bon": what is left on a gift voucher, by its code',
    description:
      'Task 536. Letter case, spaces and dashes do not matter. Unknown code or salon → 404. At most 20 checks an hour from one address (429 RATE_LIMITED).',
  })
  @ApiZodResponse(publicGiftVoucherSchema)
  get(
    @Req() req: AppRequest,
    @Param('slug') slug: string,
    @Param('code', new ZodValidationPipe(giftVoucherCodeSchema)) code: string,
  ): Promise<PublicGiftVoucherResponse> {
    this.limiter.hit(`voucher-check:ip:${req.ip}`, 20, HOUR);
    return this.vouchers.publicByCode(slug, code);
  }
}
