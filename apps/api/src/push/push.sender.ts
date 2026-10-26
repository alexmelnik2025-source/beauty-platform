import { Logger } from '@nestjs/common';
import webpush from 'web-push';

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** What the service worker shows (see apps/web/public/sw.js). */
export interface PushMessage {
  title: string;
  body: string;
  /** Page opened by a tap on the notification. */
  url: string;
  /** Same tag = the newer notification replaces the older one on the device. */
  tag?: string;
}

/** The device unsubscribed or the app was removed: delete the subscription. */
export class PushGoneError extends Error {}

/** No push may hang longer than this. */
const SEND_TIMEOUT_MS = 30_000;
/** A message nobody received within an hour is no longer worth showing. */
const TTL_SECONDS = 3600;

/** Sends push messages. Implementations: Web Push (VAPID), in-memory (tests), off. */
export abstract class PushSender {
  /** Public VAPID key the browser subscribes with; null = push is off. */
  abstract readonly publicKey: string | null;
  abstract send(target: PushTarget, message: PushMessage): Promise<void>;
}

export class WebPushSender extends PushSender {
  private readonly logger = new Logger('Push');

  constructor(
    readonly publicKey: string,
    private readonly privateKey: string,
    private readonly subject: string,
  ) {
    super();
  }

  async send(target: PushTarget, message: PushMessage): Promise<void> {
    try {
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify(message),
        {
          vapidDetails: {
            subject: this.subject,
            publicKey: this.publicKey,
            privateKey: this.privateKey,
          },
          TTL: TTL_SECONDS,
          urgency: 'high',
          timeout: SEND_TIMEOUT_MS,
        },
      );
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      // 404 and 410: the subscription no longer exists at the push service.
      if (status === 404 || status === 410) throw new PushGoneError(`push service: ${status}`);
      // Never log the endpoint: it identifies the device.
      this.logger.warn(`Push failed${status ? ` with ${status}` : ''}`);
      throw new Error(`push failed${status ? `: ${status}` : ''}`);
    }
  }
}

/** Push is off (no VAPID keys): nothing is sent, the apps hide the switch. */
export class DisabledPushSender extends PushSender {
  readonly publicKey = null;

  async send(): Promise<void> {
    // Nothing to do.
  }
}

/** In-memory "push service" for tests. */
export class MemoryPushSender extends PushSender {
  readonly publicKey = 'BTestOnlyPublicKeyForPushInTests';
  readonly sent: (PushMessage & { endpoint: string })[] = [];
  /** Endpoints that answer "gone" (the device unsubscribed). */
  readonly gone = new Set<string>();
  /** Endpoints that fail temporarily. */
  readonly failing = new Set<string>();

  async send(target: PushTarget, message: PushMessage): Promise<void> {
    if (this.gone.has(target.endpoint)) throw new PushGoneError('gone');
    if (this.failing.has(target.endpoint)) throw new Error('push service unavailable');
    this.sent.push({ endpoint: target.endpoint, ...message });
  }

  clear(): void {
    this.sent.length = 0;
    this.gone.clear();
    this.failing.clear();
  }
}
