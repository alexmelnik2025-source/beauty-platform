import { AppException } from '../../common/app-exception';
import type { ShopSyncRun } from '../../generated/prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';

/** Runs kept in the log of one integration. */
const KEEP_RUNS = 100;

/** Closes a run of the log (with the error, if any) and keeps only the latest runs. */
export async function closeRun(
  prisma: PrismaService,
  runId: string,
  counts: { checked?: number; changed?: number; missing?: number },
  error?: unknown,
): Promise<ShopSyncRun> {
  const failed = error === undefined ? null : error;
  const run = await prisma.shopSyncRun.update({
    where: { id: runId },
    data: {
      ...counts,
      finishedAt: new Date(),
      errorCode: failed ? (failed instanceof AppException ? failed.code : 'INTERNAL') : null,
      errorMessage: failed
        ? (failed instanceof Error ? failed.message : String(failed)).slice(0, 300)
        : null,
    },
  });
  const old = await prisma.shopSyncRun.findMany({
    where: { integrationId: run.integrationId },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    skip: KEEP_RUNS,
    select: { id: true },
  });
  if (old.length > 0) {
    await prisma.shopSyncRun.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
  }
  return run;
}
