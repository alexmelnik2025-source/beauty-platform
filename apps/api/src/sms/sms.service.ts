import { Logger } from '@nestjs/common';

export interface SmsMessage {
  /** E.164, e.g. +48600100200. */
  to: string;
  text: string;
}

/**
 * Sends text messages (one-time codes). Implementations: in-memory (tests), log (local
 * development: the text goes to the API log) and disabled (no SMS gateway connected).
 * A real gateway is a paid service and is added only after the owner decides on it.
 */
export abstract class SmsService {
  /** False when no gateway is connected: clients get the code by email only. */
  abstract readonly available: boolean;
  abstract send(message: SmsMessage): Promise<void>;
}

/** No gateway: SMS is not offered to clients. */
export class DisabledSmsService extends SmsService {
  readonly available = false;

  async send(): Promise<void> {
    throw new Error('SMS is not available: no SMS gateway is connected');
  }
}

/**
 * Local development only (never allowed in production): the message, code included,
 * is written to the API log so a developer can read it.
 */
export class LogSmsService extends SmsService {
  readonly available = true;
  private readonly logger = new Logger('Sms');

  async send(message: SmsMessage): Promise<void> {
    this.logger.log(`SMS to ${message.to}: ${message.text}`);
  }
}

/** Tests: messages are kept in memory. `available` can be switched off to test the fallback. */
export class MemorySmsService extends SmsService {
  available = true;
  readonly sent: SmsMessage[] = [];

  async send(message: SmsMessage): Promise<void> {
    if (!this.available) throw new Error('SMS is not available');
    this.sent.push(message);
  }

  /** Test helper: the last message sent to `to`. */
  lastTo(to: string): SmsMessage | undefined {
    return [...this.sent].reverse().find((message) => message.to === to);
  }

  clear(): void {
    this.sent.length = 0;
    this.available = true;
  }
}
