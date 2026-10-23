import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface SendOptions {
  /**
   * Same key = same email. Sent as the Message-ID, so a retry after a crash is
   * recognised as a duplicate (providers with an idempotency API get it too).
   */
  idempotencyKey?: string;
}

/** Sends transactional email. Implementations: SMTP (Mailpit locally) and in-memory (tests). */
export abstract class MailService {
  abstract send(message: MailMessage, options?: SendOptions): Promise<void>;
}

export class SmtpMailService extends MailService {
  private readonly logger = new Logger('Mail');
  private readonly transporter: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    super();
    this.transporter = nodemailer.createTransport(smtpUrl);
  }

  async send(message: MailMessage, options: SendOptions = {}): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      ...message,
      ...(options.idempotencyKey
        ? { messageId: `<${options.idempotencyKey}@beauty-platform>` }
        : {}),
    });
    // Log the type of mail, never its content (it may contain codes or links).
    this.logger.log(`Sent "${message.subject}"`);
  }
}

/** In-memory "provider" for tests: deduplicates by idempotency key like a real provider would. */
@Injectable()
export class MemoryMailService extends MailService {
  readonly sent: MailMessage[] = [];
  private readonly keys = new Set<string>();
  private failures = 0;

  async send(message: MailMessage, options: SendOptions = {}): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('Simulated provider outage');
    }
    if (options.idempotencyKey) {
      if (this.keys.has(options.idempotencyKey)) return;
      this.keys.add(options.idempotencyKey);
    }
    this.sent.push(message);
  }

  /** Test helper: the next `count` sends fail. */
  failNext(count: number): void {
    this.failures = count;
  }

  /** Test helper: the last message sent to `to`. */
  lastTo(to: string): MailMessage | undefined {
    return [...this.sent].reverse().find((message) => message.to === to);
  }

  allTo(to: string): MailMessage[] {
    return this.sent.filter((message) => message.to === to);
  }

  clear(): void {
    this.sent.length = 0;
    this.keys.clear();
    this.failures = 0;
  }
}
