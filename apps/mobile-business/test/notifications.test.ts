import { describe, expect, it } from 'vitest';
import { BusinessApi, type NotificationList } from '../src/api';
import { badge, noticeKind, noticesOfSalon, opensVisit } from '../src/notifications';

const notice = (
  id: string,
  type: NotificationList[number]['type'],
  orgId = 'o1',
  locationId = 'l1',
  appointmentId: string | null = 'a1',
): NotificationList[number] => ({
  id,
  organizationId: orgId,
  type,
  appointmentId,
  data: {
    locationId,
    start: '2026-11-12T13:30:00.000Z',
    date: '2026-11-12',
    time: '14:30',
    serviceName: 'Strzyżenie',
    staffName: 'Kasia',
    customerName: 'Anna',
    by: 'client',
  },
  read: false,
  createdAt: '2026-11-04T10:00:00.000Z',
});

describe('the bell', () => {
  it("shows only this salon's notifications, in the order they came", () => {
    const list = [
      notice('n1', 'appointment.booked'),
      notice('n2', 'appointment.booked', 'o1', 'l2'),
      notice('n3', 'appointment.cancelled', 'o2', 'l1'),
      notice('n4', 'appointment.rescheduled'),
    ];
    expect(noticesOfSalon(list, 'o1', 'l1').map((n) => n.id)).toEqual(['n1', 'n4']);
  });

  it('names the change and opens the visit unless it was cancelled', () => {
    expect(noticeKind(notice('n', 'appointment.booked'))).toBe('booked');
    expect(noticeKind(notice('n', 'appointment.created'))).toBe('created');
    expect(noticeKind(notice('n', 'appointment.rescheduled'))).toBe('rescheduled');
    expect(noticeKind(notice('n', 'appointment.cancelled'))).toBe('cancelled');
    expect(opensVisit(notice('n', 'appointment.rescheduled'))).toBe(true);
    expect(opensVisit(notice('n', 'appointment.cancelled'))).toBe(false);
    expect(opensVisit(notice('n', 'appointment.booked', 'o1', 'l1', null))).toBe(false);
  });

  it('the number on the bell', () => {
    expect(badge(0)).toBe('');
    expect(badge(3)).toBe('3');
    expect(badge(150)).toBe('99+');
  });

  it('reads the list and the count, marks one or all as read', async () => {
    const calls: [string, unknown][] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const key = `${init?.method} ${url.replace('https://api.test', '')}`;
      calls.push([key, init?.body ? JSON.parse(String(init.body)) : undefined]);
      const data = key.startsWith('POST /v1/auth/refresh')
        ? { accessToken: 'a1', expiresIn: 900, refreshToken: 'refresh-token-0123456789new' }
        : {};
      return new Response(JSON.stringify(data), { status: 200 });
    };
    const store = { get: async () => 'refresh-token-0123456789abc', set: async () => undefined };
    const api = new BusinessApi('https://api.test', store, fetchFn);
    await api.restore();
    await api.notifications(100);
    await api.unreadNotifications();
    await api.markNotificationsRead({ ids: ['n1'] });
    await api.markNotificationsRead({ all: true });
    expect(calls.slice(1)).toEqual([
      ['GET /v1/me/notifications?limit=100', undefined],
      ['GET /v1/me/notifications/unread-count', undefined],
      ['POST /v1/me/notifications/read', { ids: ['n1'] }],
      ['POST /v1/me/notifications/read', { all: true }],
    ]);
  });
});
