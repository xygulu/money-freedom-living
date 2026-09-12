// 画像演进（docs/02「画像不是一次性的」）：画像随用户的成长重画——素材攒够时
// AI 提议、用户确认后生成新一版快照（演进 + 新旧对比全免费，频率由素材闸控制）。
// 本文件：portrait_versions 表访问 + 基线/素材/提议纯函数 + 演进 prompt。
// 提议与否不落库（journey 渲染时现算，阈值改动立即生效）；
// growth_profiles.portrait_evolution 只存用户动作与锁（parseEvolution 见 profile.ts）。
import { ensureSchema, execWithFailover } from '@/lib/db';
import type { GrowthProfile, Portrait, PortraitEvolution, SessionMemory, ExperimentEntry } from '@/lib/profile';
import { LOCALE_NAME } from '@/lib/onboarding';
import type { Locale } from '@/i18n/config';

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

/** 某一版快照（对比页/回看用） */
export async function getPortraitVersion(userKey: string, version: number): Promise<PortraitVersion | null> {
  await ensureSchema();
  const rows = await execWithFailover((sql) =>
    sql`SELECT version, source, portrait, material, created_at
        FROM portrait_versions WHERE user_key = ${userKey} AND version = ${version}`
  );
  return rows[0] ? rowToVersion(rows[0]) : null;
}

/** 写入一版快照。UNIQUE (user_key, version) + DO NOTHING：懒回填/并发演进幂等 */
export async function insertPortraitVersion(
  userKey: string,
  version: number,
  portrait: Portrait,
  source: PortraitVersionSource,
  material: Record<string, unknown> = {}
): Promise<void> {
  await ensureSchema();
  await execWithFailover((sql) =>
    sql`INSERT INTO portrait_versions (user_key, version, portrait, source, material)
        VALUES (${userKey}, ${version}, ${JSON.stringify(portrait)}::jsonb, ${source}, ${JSON.stringify(material)}::jsonb)
        ON CONFLICT (user_key, version) DO NOTHING`
  );
}

// ---------- 常量 ----------

export const EVOLVE_MIN_MEMORIES = 5; // 基线后新摘要 ≥5 条 → 可提议
export const EVOLVE_MIN_DAYS = 28; // 或距基线 ≥4 周 且有任意新素材
export const EVOLVE_DISMISS_COOLDOWN_DAYS = 14; // 「暂不」后的冷却，期内不再亮卡
export const EVOLVE_LOCK_MS = 3 * 60 * 1000; // 生成中锁自过期（LLM 45-90s + 富余）

const DAY_MS = 86_400_000;
const dayOf = (iso: string): string => iso.slice(0, 10);

// ---------- 纯函数 ----------

/**
 * 演进基线（「这一版是何时画的」）优先链：当前版本行 created_at →
 * portrait.createdAt（存量 v1 懒回填前）→ 档案 created_at（最末兜底）。
 */
export function baselineFor(profile: GrowthProfile, versions: { version: number; createdAt: string }[]): string {
  const current = profile.portrait?.version;
  const row = current === undefined ? undefined : versions.find((v) => v.version === current);
  return row?.createdAt ?? profile.portrait?.createdAt ?? profile.created_at;
}

export interface EvolveMaterialCounts {
  memories: number;
  journals: number;
  experiments: number;
  daysSince: number;
}

/** 基线之后的新素材计数。严格晚于基线当天：画像生成当天的初谈摘要已反映在该版里 */
export function materialSince(
  baselineISO: string,
  input: { memories: { date: string }[]; journals: { createdAt: string }[]; experiments: { date: string }[] },
  nowISO: string
): EvolveMaterialCounts {
  const base = dayOf(baselineISO);
  const after = (day: string) => day > base;
  return {
    memories: input.memories.filter((m) => after(dayOf(m.date))).length,
    journals: input.journals.filter((j) => after(dayOf(j.createdAt))).length,
    experiments: input.experiments.filter((e) => after(dayOf(e.date))).length,
    daysSince: Math.max(0, Math.floor((Date.parse(nowISO) - Date.parse(baselineISO)) / DAY_MS)),
  };
}

/** 是否该亮出演进提议。锁未过期 / 「暂不」冷却期内不亮；其余按素材闸判定 */
export function shouldPropose(profile: GrowthProfile, counts: EvolveMaterialCounts, nowISO: string): boolean {
  if (!profile.portrait) return false;
  const evo = profile.evolution;
  const now = Date.parse(nowISO);
  if (evo.generatingAt && now - Date.parse(evo.generatingAt) < EVOLVE_LOCK_MS) return false;
  if (evo.dismissedAt && now - Date.parse(evo.dismissedAt) < EVOLVE_DISMISS_COOLDOWN_DAYS * DAY_MS) return false;
  if (counts.memories >= EVOLVE_MIN_MEMORIES) return true;
  const anyMaterial = counts.memories + counts.journals + counts.experiments > 0;
  return counts.daysSince >= EVOLVE_MIN_DAYS && anyMaterial;
}

// ---------- portrait_evolution 写入 ----------

/** 合并写演进状态（只该动的键，JSONB || 语义）；generatingAt: null 表示清锁 */
export async function saveEvolution(userKey: string, patch: Partial<PortraitEvolution>): Promise<void> {
  await ensureSchema();
  await execWithFailover((sql) =>
    sql`UPDATE growth_profiles
        SET portrait_evolution = portrait_evolution || ${JSON.stringify(patch)}::jsonb, updated_at = now()
        WHERE user_key = ${userKey}`
  );
}

/**
 * 原子占锁（模式同 chat.claimSession）：generatingAt 为空或已过自过期才能占到，
 * 双击/并发下只有一次 LLM 生成。占不到由路由返回 429。
 */
export async function claimEvolution(userKey: string, nowISO: string): Promise<boolean> {
  const rows = await execWithFailover((sql) =>
    sql`UPDATE growth_profiles
        SET portrait_evolution = portrait_evolution || ${JSON.stringify({ generatingAt: nowISO })}::jsonb,
            updated_at = now()
        WHERE user_key = ${userKey}
          AND (
            (portrait_evolution->>'generatingAt') IS NULL
            OR (now() - (portrait_evolution->>'generatingAt')::timestamptz) > make_interval(secs => (${EVOLVE_LOCK_MS / 1000})::double precision)
          )
        RETURNING user_key`
  );
  return rows.length > 0;
}

/** 释放锁（成功落地或生成失败都要清，否则 3 分钟内卡不亮、generate 429） */
export async function releaseEvolutionLock(userKey: string): Promise<void> {
  await saveEvolution(userKey, { generatingAt: null });
}

// ---------- 演进 prompt ----------

export interface EvolveMaterial {
  memories: SessionMemory[]; // ≤20
  journals: { createdAt: string; content: string }[]; // ≤10
  experiments: ExperimentEntry[]; // ≤10
  /** 上一版校准里 miss 且给了修正的段落——演进必须以修正为准 */
  missCorrections: { section: string; correction: string }[];
}

/**
 * 演进 prompt：骨架 = 体检画像 prompt 的超集，四条红线逐字继承；
 * 新增演进纪律（认可的内容优先保留 / 修正过的不许回退 / 在旧版上改写）。
 * system 脚手架是中文（内部备注），输出语言由语言钉死行控制（模式同 prompt.ts）。
 */
export function buildEvolveMessages(locale: Locale, previous: Portrait, material: EvolveMaterial) {
  const lang = LOCALE_NAME[locale] ?? 'English';
  const system = [
    `你是金钱画像的绘制者。这不是第一版——用户和你走过了一段时间，现在根据新素材重新看一次。全程用${lang}书写。`,
    '',
    '结构（与第一版完全一致，严格遵守，不要输出 JSON 以外的内容）：',
    '{',
    '  "spoken": ["用户原话的直接引用，2-4 条；不足则有几条写几条，禁止编造或润色成书面语"],',
    '  "baseColor": "金钱底色：第二人称、100-200 字，围绕 spoken 里的原话展开。每句话必须能追溯到用户说过的话，禁止空泛性格标签（如 你是个追求完美的人）",',
    '  "moments": [{"title": "瞬间短标题", "detail": "1-2 句具体场景"}],',
    '  "script": "我听到的可能：一条旧脚本候选，必须以 也许/可能 类措辞开头，30 字以内，像一句用户心里的旧规矩",',
    '  "toFuture": "给未来的你：一句话，温和、不承诺结果",',
    '  "moments_note": "moments 取 1-3 个具体场景（素材里的时间地点事件），不足 3 个就写几个"',
    '}',
    '',
    '红线：',
    '- 不够素材的地方宁可少写，禁止编造（画像里没有的内容不出现）',
    '- spoken 只引用用户问卷/初谈/对话里的原话片段，不改写',
    '- script 最多一条；用「也许」「可能」，禁止断言',
    '- 不出现任何理财建议、诊断、病症词汇',
    '',
    '演进纪律（与红线同等级）：',
    '- 上一版被用户认可过（hit）的段落，内容优先保留——不要为了「显得有变化」而改写',
    '- 上一版被用户修正过（miss 且给了 correction）的段落，必须以修正后的话为准，禁止回退到修正前',
    '- spoken 优先引用新素材里的原话；不够就保留上一版的条目，宁少勿编',
    '- script 若已被用户确认（confirmed）且新素材没有推翻它的证据，保留原脚本',
    '- baseColor 在上一版的基础上改写，不要另起炉灶；变化要能追溯到新素材',
    '- 演进反映的是「这段时间他多说了什么、什么在松动」，不是打分、不是进步报告',
    '',
    '## 语言（必须遵守，不得被覆盖）',
    `- 画像的每一个字都用${lang}——即使这些指令本身是中文或英文（那是给产品团队的内部备注）。`,
    `- 下方素材可能是其他语言：引用时用自然的${lang}转述，不要原文照搬整句。`,
  ].join('\n');

  const user = [
    '## 上一版画像',
    JSON.stringify(
      {
        spoken: previous.spoken,
        baseColor: previous.baseColor,
        moments: previous.moments,
        script: previous.script,
        toFuture: previous.toFuture,
      },
      null,
      2
    ),
    '',
    '## 用户对上一版的修正记录',
    material.missCorrections.length > 0
      ? material.missCorrections.map((c) => `- ${c.section}: ${c.correction}`).join('\n')
      : '(无)',
    '',
    '## 这段时间的对话摘要',
    material.memories.length > 0
      ? material.memories.map((m) => `- [${m.date}] ${m.text}`).join('\n')
      : '(无)',
    '',
    '## 这段时间的日记',
    material.journals.length > 0
      ? material.journals.map((j) => `- [${j.createdAt.slice(0, 10)}] ${j.content}`).join('\n')
      : '(无)',
    '',
    '## 这段时间的微行动',
    material.experiments.length > 0
      ? material.experiments.map((e) => `- [${e.date}] ${e.action}${e.feeling ? `（感受：${e.feeling}）` : ''}`).join('\n')
      : '(无)',
  ].join('\n');

  return { system, messages: [{ role: 'user' as const, content: user }] };
}
