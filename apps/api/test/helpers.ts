import 'reflect-metadata';
import { DiscoveryModule } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { expect } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { RateLimiterService } from '../src/common/rate-limiter.service';
import { MailService, MemoryMailService } from '../src/mail/mail.service';
import { PrismaService } from '../src/prisma/prisma.service';

export const PASSWORD = 'correct-horse-battery';

export interface TestContext {
  app: NestExpressApplication;
  prisma: PrismaService;
  mail: MemoryMailService;
  http: () => ReturnType<typeof request>;
}

export async function createTestApp(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, DiscoveryModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app, { docs: true });
  await app.init();
  const mail = app.get(MailService);
  if (!(mail instanceof MemoryMailService)) {
    throw new Error('Tests must run with MAIL_TRANSPORT=memory');
  }
  return {
    app,
    prisma: app.get(PrismaService),
    mail,
    http: () => request(app.getHttpServer()),
  };
}

/** Empties every table (fast, keeps migrations) and resets in-memory state. */
export async function resetState(ctx: TestContext): Promise<void> {
  await ctx.prisma.$executeRawUnsafe(
    'TRUNCATE TABLE app_user, organization, audit_log RESTART IDENTITY CASCADE',
  );
  ctx.mail.clear();
  ctx.app.get(RateLimiterService).reset();
}

/** The one-time code from the last email sent to `email`. */
export function codeFromEmail(ctx: TestContext, email: string): string {
  const message = ctx.mail.lastTo(email);
  const match = message?.text.match(/(?:Kod|Код|Code): (\S+)/);
  if (!match?.[1]) {
    throw new Error(`No code in the last email to ${email}`);
  }
  return match[1];
}

export interface SignedInUser {
  userId: string;
  email: string;
  accessToken: string;
  auth: { Authorization: string };
}

/** Registers, confirms the email and signs in (web client). */
export async function signUp(
  ctx: TestContext,
  email: string,
  name = 'Test Owner',
): Promise<SignedInUser> {
  await ctx.http().post('/v1/auth/register').send({ email, password: PASSWORD, name }).expect(202);
  await ctx
    .http()
    .post('/v1/auth/verify-email')
    .send({ token: codeFromEmail(ctx, email) })
    .expect(200);
  const res = await ctx
    .http()
    .post('/v1/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);
  return {
    userId: res.body.user.id,
    email,
    accessToken: res.body.accessToken,
    auth: { Authorization: `Bearer ${res.body.accessToken}` },
  };
}

export const LOCATION = {
  name: 'Barber Mokotów',
  addressLine: 'ul. Puławska 1',
  city: 'Warszawa',
  postalCode: '02-515',
};

export async function createOrgWithLocation(
  ctx: TestContext,
  user: SignedInUser,
  orgName: string,
): Promise<{ orgId: string; locationId: string; slug: string }> {
  const org = await ctx
    .http()
    .post('/v1/organizations')
    .set(user.auth)
    .send({ name: orgName })
    .expect(201);
  const location = await ctx
    .http()
    .post(`/v1/organizations/${org.body.id}/locations`)
    .set(user.auth)
    .send({ ...LOCATION, name: `${orgName} Centrum` })
    .expect(201);
  return { orgId: org.body.id, locationId: location.body.id, slug: location.body.slug };
}

export function expectError(body: { error?: { code?: string } }, code: string): void {
  expect(body.error?.code).toBe(code);
}
