import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators';
import { ApiZodResponse } from '../common/openapi';
import { ClientGuard, CurrentClient } from './client-auth';
import { clientFavoritesSchema, type ClientFavoritesResponse } from './client-favorites.responses';
import { ClientFavoritesService } from './client-favorites.service';
import type { ClientAuth } from './client.service';

/** "Favourite salons" in the client app (task 23). */
@ApiTags('client app')
@Public()
@UseGuards(ClientGuard)
@ApiBearerAuth()
@Controller('client/favorites')
export class ClientFavoritesController {
  constructor(private readonly favorites: ClientFavoritesService) {}

  @Get()
  @ApiOperation({
    summary: 'My favourite salons',
    description:
      'Newest first. Only public salon data; bookable=false while the salon has online booking off.',
  })
  @ApiZodResponse(clientFavoritesSchema)
  list(@CurrentClient() client: ClientAuth): Promise<ClientFavoritesResponse> {
    return this.favorites.list(client);
  }

  @Put(':slug')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Add a salon to my favourites',
    description:
      'Idempotent. 404 when no salon with this booking link takes online bookings; 409 TOO_MANY_FAVORITES over 100.',
  })
  add(@CurrentClient() client: ClientAuth, @Param('slug') slug: string): Promise<void> {
    return this.favorites.add(client, slug);
  }

  @Delete(':slug')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a salon from my favourites (no error if it is not there)' })
  remove(@CurrentClient() client: ClientAuth, @Param('slug') slug: string): Promise<void> {
    return this.favorites.remove(client, slug);
  }
}
