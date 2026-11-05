import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
import { AvailabilityService } from '../src/scheduling/availability.service';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
import {
  createOrgWithLocation,
  createTestApp,
  LEGAL_TEXTS,
  resetState,
  signUp,
  type TestContext,
} from './helpers';

const TZ = 'Europe/Warsaw';
let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
});

describe('"Wolne dziś" (task 120)', () => {
  it('lists the specialists who can still be booked today, in the salon time zone', async () => {
    const owner = await signUp(ctx, 'free-today@example.com');
    const salon = await createOrgWithLocation(ctx, owner, 'Free today');
    const base = `/v1/organizations/${salon.orgId}/locations/${salon.locationId}`;
    const service = async (name: string, durationMinutes: number) =>
      (
        await ctx
          .http()
          .post(`${base}/services`)
          .set(owner.auth)
          .send({ name, durationMinutes, priceGrosze: 5000 })
          .expect(201)
      ).body.id as string;
    const haircut = await service('Strzyżenie', 60);
    const beard = await service('Broda', 30);
    const staff = async (displayName: string, serviceIds: string[], start: string, end: string) => {
      const id = (
        await ctx
          .http()
          .post(`${base}/staff`)
          .set(owner.auth)
          .send({ displayName, serviceIds })
          .expect(201)
      ).body.id as string;
      await ctx
        .http()
        .put(`${base}/staff/${id}/working-hours`)
        .set(owner.auth)
        .send({
          days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
            weekday,
            intervals: [{ start, end }],
          })),
        })
        .expect(200);
      return id;
    };
    const kasia = await staff('Kasia', [haircut], '10:00', '18:00');
    // Ends at 10:30: at 09:00 with the salon's 60 minutes' notice only her 30-minute beard fits.
    const ola = await staff('Ola', [haircut, beard], '08:00', '10:30');
    const marek = await staff('Marek', [haircut], '08:00', '10:00');
    const tomek = await staff('Tomek', [haircut], '10:00', '18:00');

    const day = addDays(localToday(Date.now(), TZ), 5);
    await ctx
      .http()
      .post(`${base}/staff/${tomek}/time-off`)
      .set(owner.auth)
      .send({ start: `${day}T00:00`, end: `${addDays(day, 1)}T00:00`, note: 'Urlop' })
      .expect(201);
    const location = await ctx.prisma.location.update({
      where: { id: salon.locationId },
      data: { onlineBookingEnabled: true, ...LEGAL_TEXTS },
    });
    const availability = ctx.app.get(AvailabilityService);

    // 09:00: Kasia from 10:00, Ola's beard at 10:00; Marek's hour no longer fits; Tomek is off.
    const morning = await availability.freeToday(location, zonedToInstant(day, 9 * 60, TZ));
    expect(morning).toEqual({ date: day, staffIds: [kasia, ola] });
    expect(morning.staffIds).not.toContain(marek);

    // 17:30: nothing left today, even for Kasia (60 minutes' notice).
    const evening = await availability.freeToday(location, zonedToInstant(day, 17 * 60 + 30, TZ));
    expect(evening).toEqual({ date: day, staffIds: [] });

    // Over HTTP: the shape, and a salon without online booking is not found.
    const response = await ctx
      .http()
      .get(`/v1/public/locations/${salon.slug}/free-today`)
      .expect(200);
    expect(response.body.date).toBe(localToday(Date.now(), TZ));
    expect(registeredResponseSchema('PublicFreeToday').safeParse(response.body).success).toBe(true);
    await ctx.prisma.location.update({
      where: { id: salon.locationId },
      data: { onlineBookingEnabled: false },
    });
    await ctx.http().get(`/v1/public/locations/${salon.slug}/free-today`).expect(404);
  });
});
