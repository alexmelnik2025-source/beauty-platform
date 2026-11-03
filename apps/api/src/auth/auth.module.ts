import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccessTokenService } from './access-token.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { MeController } from './me.controller';
import { PasswordService } from './password.service';
import { CodeLoginService } from './code-login.service';
import { OrganizationsModule } from '../organizations/organizations.module';

@Module({
  imports: [OrganizationsModule],
  controllers: [AuthController, MeController],
  providers: [
    AuthService,
    CodeLoginService,
    PasswordService,
    AccessTokenService,
    // Every route requires sign-in unless marked @Public().
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AuthModule {}
