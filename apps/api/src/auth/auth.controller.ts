import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AppException } from '../common/app-exception';
import { ApiZodBody, ApiZodResponse } from '../common/openapi';
import { RateLimiterService } from '../common/rate-limiter.service';
import type { AppRequest } from '../common/request-context';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { APP_CONFIG, type AppConfig } from '../config/config';
import {
  emailOnlySchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  tokenSchema,
  type LoginInput,
  type RegisterInput,
  type ResetPasswordInput,
} from './auth.schemas';
import { messageSchema, tokensSchema, type TokenResponse } from './auth.responses';
import { AuthService, type IssuedTokens } from './auth.service';
import { CurrentAuth, Public } from './decorators';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './refresh-cookie';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ACCEPTED = { message: 'If the address can receive email, a message has been sent' };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly secureCookies: boolean;

  constructor(
    private readonly auth: AuthService,
    private readonly limiter: RateLimiterService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.secureCookies = config.NODE_ENV === 'production';
  }

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Register an owner account and send a verification email' })
  @ApiZodBody(registerSchema)
  @ApiZodResponse(messageSchema, HttpStatus.ACCEPTED)
  async register(
    @Req() req: AppRequest,
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterInput,
  ): Promise<typeof ACCEPTED> {
    this.limiter.hit(`register:ip:${req.ip}`, 10, HOUR);
    this.limiter.hit(`email:${body.email}`, 5, HOUR);
    await this.auth.register(body);
    return ACCEPTED;
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm the email address with the code from the email' })
  @ApiZodBody(tokenSchema)
  @ApiZodResponse(messageSchema)
  async verifyEmail(
    @Body(new ZodValidationPipe(tokenSchema)) body: { token: string },
  ): Promise<{ message: string }> {
    await this.auth.verifyEmail(body.token);
    return { message: 'Email confirmed' };
  }

  @Public()
  @Post('resend-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Send the verification email again' })
  @ApiZodBody(emailOnlySchema)
  @ApiZodResponse(messageSchema, HttpStatus.ACCEPTED)
  async resendVerification(
    @Req() req: AppRequest,
    @Body(new ZodValidationPipe(emailOnlySchema)) body: { email: string },
  ): Promise<typeof ACCEPTED> {
    this.limiter.hit(`resend:ip:${req.ip}`, 10, HOUR);
    this.limiter.hit(`email:${body.email}`, 5, HOUR);
    await this.auth.resendVerification(body.email);
    return ACCEPTED;
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in',
    description:
      'clientType=web: refresh token is set as an httpOnly cookie. clientType=mobile: refresh token is returned in the body; store it in the Keychain/Keystore.',
  })
  @ApiZodBody(loginSchema)
  @ApiZodResponse(tokensSchema)
  async login(
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
  ): Promise<TokenResponse> {
    this.limiter.hit(`login:ip:${req.ip}`, 30, 15 * MINUTE);
    this.limiter.hit(`login:email:${body.email}`, 10, 15 * MINUTE);
    const tokens = await this.auth.login(body, { userAgent: req.header('user-agent') });
    return this.tokenResponse(res, tokens, body.clientType);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get a new access token',
    description:
      'Web: uses the cookie. Mobile: send refreshToken in the body. The refresh token rotates every time.',
  })
  @ApiZodBody(refreshSchema)
  @ApiZodResponse(tokensSchema)
  async refresh(
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
    @Body(new ZodValidationPipe(refreshSchema)) body: { refreshToken?: string },
  ): Promise<TokenResponse> {
    this.limiter.hit(`refresh:ip:${req.ip}`, 120, 15 * MINUTE);
    const fromBody = body.refreshToken;
    const token = fromBody ?? readRefreshCookie(req);
    if (!token) {
      throw new AppException(
        HttpStatus.UNAUTHORIZED,
        'INVALID_REFRESH_TOKEN',
        'Session expired, sign in again',
      );
    }
    try {
      const tokens = await this.auth.refresh(token);
      return this.tokenResponse(res, tokens, fromBody ? 'mobile' : 'web');
    } catch (error) {
      if (!fromBody) clearRefreshCookie(res, this.secureCookies);
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sign out of this device' })
  async logout(
    @CurrentAuth() auth: { sessionId: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(auth.sessionId);
    clearRefreshCookie(res, this.secureCookies);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Send a password reset email' })
  @ApiZodBody(emailOnlySchema)
  @ApiZodResponse(messageSchema, HttpStatus.ACCEPTED)
  async forgotPassword(
    @Req() req: AppRequest,
    @Body(new ZodValidationPipe(emailOnlySchema)) body: { email: string },
  ): Promise<typeof ACCEPTED> {
    this.limiter.hit(`forgot:ip:${req.ip}`, 10, HOUR);
    this.limiter.hit(`email:${body.email}`, 5, HOUR);
    await this.auth.forgotPassword(body.email);
    return ACCEPTED;
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set a new password with the code from the email; signs out all devices',
  })
  @ApiZodBody(resetPasswordSchema)
  @ApiZodResponse(messageSchema)
  async resetPassword(
    @Req() req: AppRequest,
    @Body(new ZodValidationPipe(resetPasswordSchema)) body: ResetPasswordInput,
  ): Promise<{ message: string }> {
    this.limiter.hit(`reset:ip:${req.ip}`, 20, HOUR);
    await this.auth.resetPassword(body);
    return { message: 'Password changed. Sign in with the new password' };
  }

  private tokenResponse(
    res: Response,
    tokens: IssuedTokens,
    clientType: 'web' | 'mobile',
  ): TokenResponse {
    if (clientType === 'web') {
      setRefreshCookie(res, tokens.refreshToken, tokens.refreshExpiresAt, this.secureCookies);
    }
    return {
      accessToken: tokens.accessToken,
      expiresIn: tokens.expiresIn,
      user: tokens.user,
      ...(clientType === 'mobile'
        ? {
            refreshToken: tokens.refreshToken,
            refreshExpiresAt: tokens.refreshExpiresAt.toISOString(),
          }
        : {}),
    };
  }
}
