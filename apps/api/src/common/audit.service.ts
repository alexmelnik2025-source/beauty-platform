import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  organizationId?: string | null;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  /** Never put passwords, tokens or other secrets here. */
  metadata?: Prisma.InputJsonValue;
}

type Db = Pick<PrismaService, 'auditLog'> | Prisma.TransactionClient;

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Pass a transaction client to record the entry atomically with the change itself. */
  async record(entry: AuditEntry, db: Db = this.prisma): Promise<void> {
    await db.auditLog.create({ data: entry });
  }
}
