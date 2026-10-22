import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Sends transactional email. Implementations: SMTP (Mailpit locally) and in-memory (tests). */
export abstract class MailService {
  abstract send(message: MailMessage): Promise<void>;
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

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({ from: this.from, ...message });
    // Log the type of mail, never its content (it may contain tokens).
    this.logger.log(`Sent "${message.subject}"`);
  }
}

@Injectable()
export class MemoryMailService extends MailService {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }

  /** Test helper: the last message sent to `to`. */
  lastTo(to: string): MailMessage | undefined {
    return [...this.sent].reverse().find((message) => message.to === to);
  }

  clear(): void {
    this.sent.length = 0;
  }
}
