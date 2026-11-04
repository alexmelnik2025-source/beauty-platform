import { Inject, Injectable } from '@nestjs/common';
import { notFound } from '../common/app-exception';
import { generateToken, hashToken } from '../common/crypto';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { instantToLocal } from '../scheduling/time';
import { renderCalendarEvent } from './booking-templates';
import { buildIcs } from './ics';

/** The client's calendar reminds them an hour before the visit. */
const ALARM_MINUTES_BEFORE = 60;
/** Like the manage links in the emails: valid until a week after the visit. */
const LINK_DAYS_AFTER_VISIT = 7;
const DAY_MS = 86_400_000;

/**
 * Task 20: "Add to calendar" — the visit behind a manage link (from the booking emails or
 * the confirmation page) as an .ics file. Same token, same expiry as the manage link; a
 * cancelled visit comes back as STATUS:CANCELLED, so a calendar that imported it before
 * can drop it. No client contacts are in the file.
 */
@Injectable()
export class VisitCalendarService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Task 22: the client app ("My visits", signed in by email code) asks for a calendar
   * file of one of the client's own visits. A fresh link is made (only token hashes are
   * stored), so the phone can open it without the app's sign-in. Someone else's visit
   * looks exactly like a missing one.
   */
  async linkForClient(email: string, appointmentId: string): Promise<{ url: string }> {
    const appointment = await this.prisma.appointment.findFirst({
      where: {
        id: appointmentId,
        customer: { email },
        status: { notIn: ['held', 'expired'] },
      },
    });
    if (!appointment) throw notFound('Appointment');
    const token = generateToken();
    await this.prisma.appointmentAccessToken.create({
      data: {
        appointmentId: appointment.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(appointment.startAt.getTime() + LINK_DAYS_AFTER_VISIT * DAY_MS),
      },
    });
    return { url: `${this.config.APP_WEB_URL}/v1/public/appointments/${token}/calendar.ics` };
  }

  async byToken(token: string): Promise<{ filename: string; body: string }> {
    const access = await this.prisma.appointmentAccessToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { appointment: { include: { location: true, service: true, staff: true } } },
    });
    const appointment = access?.appointment;
    if (
      !access ||
      !appointment ||
      access.expiresAt.getTime() <= Date.now() ||
      appointment.status === 'held' ||
      appointment.status === 'expired'
    ) {
      throw notFound('Appointment');
    }
    const { location } = appointment;
    const manageLink = `${this.config.APP_WEB_URL}/${appointment.locale}/m/${token}`;
    const { summary, description } = renderCalendarEvent(appointment.locale, {
      salonName: location.name,
      serviceName: appointment.service.name,
      staffName: appointment.staff.displayName,
      manageLink,
    });
    const body = buildIcs({
      uid: `${appointment.id}@beauty-platform`,
      sequence: appointment.version,
      start: appointment.startAt,
      end: appointment.endAt,
      summary,
      location: `${location.name}, ${location.addressLine}, ${location.postalCode} ${location.city}`,
      description,
      url: manageLink,
      cancelled: appointment.status === 'cancelled',
      alarmMinutesBefore: ALARM_MINUTES_BEFORE,
      now: new Date(),
    });
    const day = instantToLocal(appointment.startAt.getTime(), location.timezone).date;
    return { filename: `visit-${day}.ics`, body };
  }
}
