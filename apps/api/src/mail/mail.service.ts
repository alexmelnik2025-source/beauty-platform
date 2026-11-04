import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { senderMailbox, textToHtml } from './compose';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Shown as the sender instead of the platform's name, e.g. the salon ("Berber Moda"). */
  senderName?: string;
  /** Where the client's reply goes, e.g. the salon's own email. */
  replyTo?: string;
  /** Language of the email (the HTML version's lang attribute). */
  lang?: string;
}

/** What actually leaves: From with the salon's name, Reply-To, plain text and HTML. */
export interface OutgoingMail {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
}

export function outgoing(message: MailMessage, mailFrom: string): OutgoingMail {
  return {
    from: senderMailbox(mailFrom, message.senderName),
    to: message.to,
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    subject: message.subject,
    text: message.text,
    html: textToHtml(message.text, message.lang),
  };
}

export interface SendOptions {
  /**
   * Same key = same email. A provider that supports idempotency keys (Resend) sends
   * it at most once within its window, so a retry after a crash is not a duplicate.
   */
  idempotencyKey?: string;
}

/** Sends transactional email. Implementations: SMTP (Mailpit locally), Resend API, in-memory (tests). */
export abstract class MailService {
  abstract send(message: MailMessage, options?: SendOptions): Promise<void>;
}

/** No send may hang longer than this; the email queue locks a row for 5 minutes. */
export const SEND_TIMEOUT_MS = 60_000;

/** Removes email addresses from text that is stored or logged (provider error messages). */
export function maskEmails(text: string): string {
  return text.replace(/[^\s<>"'@,;:]+@[^\s<>"'@,;:]+/g, '***@***');
}

export class SmtpMailService extends MailService {
  private readonly logger = new Logger('Mail');
  private readonly transporter: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    super();
    this.transporter = nodemailer.createTransport(smtpUrl, {
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: SEND_TIMEOUT_MS,
    });
  }

  async send(message: MailMessage, options: SendOptions = {}): Promise<void> {
    await this.transporter.sendMail({
      ...outgoing(message, this.from),
      ...(options.idempotencyKey
        ? {
            messageId: `<${options.idempotencyKey}@beauty-platform>`,
            // Honoured by Resend's SMTP relay; other servers ignore unknown headers.
            headers: { 'Resend-Idempotency-Key': options.idempotencyKey },
          }
        : {}),
    });
    // Log the type of mail, never its content (it may contain codes or links).
    this.logger.log(`Sent "${message.subject}"`);
  }
}

/** Error that is worth retrying later (the provider is busy with the same key, rate limit, 5xx). */
export class MailRetryableError extends Error {}

/**
 * Resend HTTP API. The `Idempotency-Key` header makes Resend send an email with a
 * given key at most once in 24 hours: a repeat returns the first response.
 * https://resend.com/docs/dashboard/emails/idempotency-keys
 */
export class ResendMailService extends MailService {
  private readonly logger = new Logger('Mail');

  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
    private readonly from: string,
  ) {
    super();
  }

  async send(message: MailMessage, options: SendOptions = {}): Promise<void> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey.slice(0, 256);
    const response = await fetch(`${this.apiUrl.replace(/\/+$/, '')}/emails`, {
      method: 'POST',
      headers,
      body: JSON.stringify(resendBody(outgoing(message, this.from))),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (response.ok) {
      this.logger.log(`Sent "${message.subject}"`);
      return;
    }
    let name = '';
    try {
      const body = (await response.json()) as { name?: unknown };
      name = typeof body.name === 'string' ? body.name : '';
    } catch {
      // not JSON
    }
    const text = `Resend answered ${response.status}${name ? ` ${name}` : ''}`;
    // Same key still being processed, rate limit, provider trouble: try again later.
    if (
      response.status === 429 ||
      response.status >= 500 ||
      name === 'concurrent_idempotent_requests'
    ) {
      throw new MailRetryableError(text);
    }
    throw new Error(text);
  }
}

function resendBody(mail: OutgoingMail) {
  return {
    from: mail.from,
    to: [mail.to],
    ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  };
}

/** In-memory "provider" for tests: deduplicates by idempotency key like a real provider would. */
@Injectable()
export class MemoryMailService extends MailService {
  readonly sent: (MailMessage & { outgoing: OutgoingMail })[] = [];
  /** MAIL_FROM of the test app, so tests see the same From header as SMTP would send. */
  mailFrom = 'Beauty Platform <no-reply@localhost>';
  private readonly keys = new Set<string>();
  private failures = 0;
  private failureMessage = 'Simulated provider outage';

  async send(message: MailMessage, options: SendOptions = {}): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error(this.failureMessage);
    }
    if (options.idempotencyKey) {
      if (this.keys.has(options.idempotencyKey)) return;
      this.keys.add(options.idempotencyKey);
    }
    this.sent.push({ ...message, outgoing: outgoing(message, this.mailFrom) });
  }

  /** Test helper: the next `count` sends fail (with `message`, if given). */
  failNext(count: number, message = 'Simulated provider outage'): void {
    this.failures = count;
    this.failureMessage = message;
  }

  /** Test helper: the last message sent to `to`. */
  lastTo(to: string): (MailMessage & { outgoing: OutgoingMail }) | undefined {
    return [...this.sent].reverse().find((message) => message.to === to);
  }

  allTo(to: string): (MailMessage & { outgoing: OutgoingMail })[] {
    return this.sent.filter((message) => message.to === to);
  }

  clear(): void {
    this.sent.length = 0;
    this.keys.clear();
    this.failures = 0;
  }
}
