import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/** Argon2id with the library defaults (19 MiB memory, 2 iterations — OWASP recommendation). */
@Injectable()
export class PasswordService {
  /** Used when the user does not exist, so login takes the same time either way. */
  private dummyHash: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return hash(password);
  }

  async verify(passwordHash: string | null, password: string): Promise<boolean> {
    if (passwordHash === null) {
      this.dummyHash ??= hash('timing-equaliser-password');
      await verify(await this.dummyHash, password).catch(() => false);
      return false;
    }
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }
}
