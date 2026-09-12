// 画像演进（docs/02「画像不是一次性的」）。本文件先落 portrait_versions 表访问
// （时间线需要画像节点）；提议判定 / 演进生成 / 锁随 c5/c6 补齐。
import { ensureSchema, execWithFailover } from '@/lib/db';
import type { Portrait } from '@/lib/profile';

export type PortraitVersionSource = 'onboarding' | 'evolve' | 'backfill';

/** portrait_versions 一行：某版画像的完整快照（含当时的 calibrations/scriptStatus） */
export interface PortraitVersion {
  version: number;
  source: PortraitVersionSource;
  portrait: Portrait;
  /** 该版基于的新素材量 {memories, journals, experiments, daysSince} */
  material: Record<string, unknown>;
  createdAt: string;
}

function rowToVersion(row: Record<string, unknown>): PortraitVersion {
  return {
    version: row.version as number,
    source: (row.source as PortraitVersionSource) ?? 'onboarding',
    portrait: row.portrait as Portrait,
    material: (row.material as Record<string, unknown> | null) ?? {},
    createdAt: String(row.created_at),
  };
}

/** 历代画像快照（version 倒序，含当前版）。存量用户可能为空（首次演进前懒回填 v1）。 */
export async function listPortraitVersions(userKey: string, limit = 50): Promise<PortraitVersion[]> {
  await ensureSchema();
  const rows = await execWithFailover((sql) =>
    sql`SELECT version, source, portrait, material, created_at
        FROM portrait_versions WHERE user_key = ${userKey}
        ORDER BY version DESC LIMIT ${limit}`
  );
  return rows.map(rowToVersion);
}
