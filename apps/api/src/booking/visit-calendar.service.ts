import { Inject, Injectable } from '@nestjs/common';
import { notFound } from '../common/app-exception';
import { hashToken } from '../common/crypto';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';
import { instantToLocal } from '../scheduling/time';
import { renderCalendarEvent } from './booking-templates';
import { buildIcs } from './ics';

/** The client's calendar reminds them an hour before the visit. */
const ALARM_MINUTES_BEFORE = 60;

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
