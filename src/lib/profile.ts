// 成长档案（growth_profiles）读写层。JSON 字段整体读写：
// 单用户并发极低（一个人和自己聊），读-改-写可接受；行级锁靠 UPDATE 的
// WHERE user_key 语义兜底，不引入额外乐观锁复杂度。
import { ensureSchema, execWithFailover, type SqlClient } from '@/lib/db';

export interface PortraitMoment {
  title: string;
  detail: string;
}

export interface Calibration {
  section: string; // 'script' | 'spoken:<i>' | 'baseColor' | 'moment:<i>' | 'toFuture'
  verdict: 'hit' | 'miss';
  correction?: string;
  at: string; // ISO
}

export interface Portrait {
  questionnaire?: Record<string, string>; // 问卷原始答案（画像生成的素材）
  spoken: string[]; // 你说过的（用户原话直接引用）
  baseColor: string; // 金钱底色（第二人称，可追溯到原话）
  moments: PortraitMoment[]; // 你和钱的三个瞬间（结构化单独存，永不参与摘要滚动）
  script: string; // 我听到的可能（旧脚本候选，也许/可能措辞）
  toFuture: string; // 给未来的你
  version: number;
  calibrations: Calibration[];
  scriptStatus: 'pending' | 'confirmed' | 'rejected'; // 脚本确认状态：确认后才进长期工作记忆
}

/** 关键对话摘要（带日期，双层记忆：会话结束写入 1-2 句轻摘要，下次对话立即可用） */
export interface SessionMemory {
  date: string; // YYYY-MM-DD
  text: string;
}

/** 微行动/实验记录（阶段 3 主用，机制上任何阶段的微行动完成都记这里） */
export interface ExperimentEntry {
  date: string; // YYYY-MM-DD
  action: string; // 做了什么（今日微行动原文）
  feeling?: string; // 一句话体感（松/紧/平静/心虚……不问对错）
}

/** 信（docs/02 §6 letters[]；阶段仪式：给现在的自己/写给钱的一封信） */
export interface LetterEntry {
  stage: number;
  content: string;
  state: 'kept' | 'sealed' | 'opened'; // 留着 / 封存 / 已开（封存开启简版）
  aiReply: string | null;
  createdAt: string; // ISO
}

export interface GrowthProfile {
  user_key: string;
  locale: string;
  portrait: Portrait | null;
  concerns: { content: string; status: string; sourceAt: string }[];
  stage: number;
  stage_started_at: string;
  pinned: { kind: string; text: string; createdAt: string }[];
  memories: SessionMemory[];
  experiments: ExperimentEntry[];
  letters: LetterEntry[];
  /** 今日一签去重：最近看过的签文（上限 90 条 ≈ 90 天不重复，docs/02 一签机制） */
  dailySeen: { date: string; text: string }[];
  payday: { type: 'monthly' | 'biweekly' | 'weekly'; day?: number } | null;
  total_active_days: number;
  last_active_date: string | null;
}

/** Neon HTTP 驱动把 DATE 解析成 JS Date（本地时区午夜）——归一化回 'YYYY-MM-DD'，
 *  否则 gap 计算 `${date}T00:00:00Z` 拼出非法串得 NaN，归来问候永不触发 */
export function dateColumnToISO(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return null;
}

function rowToProfile(row: Record<string, unknown>): GrowthProfile {
  return {
    user_key: row.user_key as string,
    locale: row.locale as string,
    portrait: (row.portrait as Portrait | null) ?? null,
    concerns: (row.concerns as GrowthProfile['concerns']) ?? [],
    stage: row.stage as number,
    stage_started_at: String(row.stage_started_at),
    pinned: (row.pinned as GrowthProfile['pinned']) ?? [],
    memories: (row.memories as GrowthProfile['memories']) ?? [],
    experiments: (row.experiments as GrowthProfile['experiments']) ?? [],
    letters: (row.letters as GrowthProfile['letters']) ?? [],
    dailySeen: (row.daily_seen as GrowthProfile['dailySeen']) ?? [],
    payday: (row.payday as GrowthProfile['payday']) ?? null,
    total_active_days: row.total_active_days as number,
    last_active_date: dateColumnToISO(row.last_active_date),
  };
}

export async function getProfile(userKey: string): Promise<GrowthProfile | null> {
  await ensureSchema();
  const rows = await execWithFailover((sql: SqlClient) =>
    sql`SELECT user_key, locale, portrait, concerns, stage, stage_started_at,
               pinned, memories, experiments, letters, daily_seen, payday,
               total_active_days, last_active_date
        FROM growth_profiles WHERE user_key = ${userKey}`
  );
  return rows[0] ? rowToProfile(rows[0]) : null;
}

/** 取档案，无则建（问卷提交/微行动完成/写信时触发，locale 取当前界面语言） */
export async function ensureProfile(userKey: string, locale: string): Promise<GrowthProfile> {
  await ensureSchema();
  const rows = await execWithFailover((sql: SqlClient) =>
    sql`
      INSERT INTO growth_profiles (user_key, locale)
      VALUES (${userKey}, ${locale})
      ON CONFLICT (user_key) DO NOTHING
      RETURNING user_key, locale, portrait, concerns, stage, stage_started_at,
                pinned, payday, total_active_days, last_active_date
    `
  );
  if (rows[0]) return rowToProfile(rows[0]);
  const existing = await getProfile(userKey);
  if (!existing) throw new Error(`档案读写冲突: ${userKey}`);
  return existing;
}

/** 整体写回 portrait JSONB（调用方先 getProfile 再改） */
export async function savePortrait(userKey: string, portrait: Portrait): Promise<void> {
  await execWithFailover((sql: SqlClient) =>
    sql`UPDATE growth_profiles
        SET portrait = ${JSON.stringify(portrait)}::jsonb, updated_at = now()
        WHERE user_key = ${userKey}`
  );
}

/** 发薪日锚点：null 表示用户跳过——不猜默认（docs/02：猜错会显得"它不懂我"） */
export async function savePayday(
  userKey: string,
  payday: { type: 'monthly' | 'biweekly' | 'weekly'; day?: number } | null
): Promise<void> {
  await execWithFailover((sql: SqlClient) =>
    sql`UPDATE growth_profiles
        SET payday = ${payday ? JSON.stringify(payday) : null}::jsonb, updated_at = now()
        WHERE user_key = ${userKey}`
  );
}

/** concerns 种子写入（问卷 Q6 等入口；status: open） */
export async function addConcern(userKey: string, content: string): Promise<void> {
  await execWithFailover((sql: SqlClient) =>
    sql`UPDATE growth_profiles
        SET concerns = concerns || ${JSON.stringify([{ content, status: 'open', sourceAt: new Date().toISOString() }])}::jsonb,
            updated_at = now()
        WHERE user_key = ${userKey}`
  );
}

/**
 * 追加会话记忆（双层记忆的轻摘要层，docs/02 §6）。
 * 按 text 去重：惰性补摘要 + 主动结束可能对同一会话触发两次，不能重复入档。
 */
export async function appendMemories(userKey: string, entries: SessionMemory[]): Promise<void> {
  if (entries.length === 0) return;
  const existing = await getProfile(userKey);
  if (!existing) return;
  const seen = new Set(existing.memories.map((m) => m.text));
  const fresh = entries.filter((e) => e.text.trim() && !seen.has(e.text.trim()));
  if (fresh.length === 0) return;
  await execWithFailover((sql: SqlClient) =>
    sql`UPDATE growth_profiles
        SET memories = memories || ${JSON.stringify(fresh.map((e) => ({ date: e.date, text: e.text.trim() })))}::jsonb,
            updated_at = now()
        WHERE user_key = ${userKey}`
  );
}

/**
 * pinned 写入（结构化字段，永不参与摘要滚动合并）：taboo 用户禁忌 / promise 重要承诺 /
 * open 未完成话题。按 text 去重；禁忌最先注入 system（P§6 优先级 2）。
 */
export async function addPinned(
  userKey: string,
  items: { kind: string; text: string }[]
): Promise<void> {
  const valid = items.filter(
    (i): i is { kind: 'taboo' | 'promise' | 'open'; text: string } =>
      ['taboo', 'promise', 'open'].includes(i.kind) && Boolean(i.text.trim())
  );
  if (valid.length === 0) return;
  const existing = await getProfile(userKey);
  if (!existing) return;
  const seen = new Set(existing.pinned.map((p) => p.text));
  const fresh = valid
    .filter((i) => !seen.has(i.text.trim()))
    .map((i) => ({ kind: i.kind, text: i.text.trim(), createdAt: new Date().toISOString() }));
  if (fresh.length === 0) return;
  await execWithFailover((sql: SqlClient) =>
    sql`UPDATE growth_profiles
        SET pinned = pinned || ${JSON.stringify(fresh)}::jsonb,
            updated_at = now()
        WHERE user_key = ${userKey}`
  );
}

/**
 * 微行动/实验记录写入（docs/02 阶段 3）：/journey 微行动卡"完成实验 + 一句话感受"。
 * 做砸的实验也是数据——记成功或记没做都算，不评判。
 */
export async function appendExperiment(
  userKey: string,
  entry: { date: string; action: string; feeling?: string }
): Promise<void> {
  await execWithFailover((sql: SqlClient) =>
    sql`UPDATE growth_profiles
        SET experiments = experiments || ${JSON.stringify([{ date: entry.date, action: entry.action, feeling: entry.feeling?.trim() || undefined }])}::jsonb,
            updated_at = now()
        WHERE user_key = ${userKey}`
  );
}

/**
 * 信写入（阶段仪式）：state 初始 'kept'（留着）。
 * createdAt 必须由调用方传入并在返回给客户端的对象里保持同一个值——
 * PATCH 封存/开启按 createdAt 定位，两处各生成一个会导致毫秒级错位。
 */
export async function appendLetter(userKey: string, entry: LetterEntry): Promise<void> {
  await execWithFailover((sql: SqlClient) =>
    sql`UPDATE growth_profiles
        SET letters = letters || ${JSON.stringify([entry])}::jsonb,
            updated_at = now()
        WHERE user_key = ${userKey}`
  );
}

/** 信状态流转（封存开启简版）：kept ↔ sealed ↔ opened，按创建时间定位 */
export async function setLetterState(
  userKey: string,
  createdAt: string,
  state: LetterEntry['state']
): Promise<void> {
  await execWithFailover((sql: SqlClient) =>
    sql`UPDATE growth_profiles
        SET letters = (
          SELECT jsonb_agg(CASE WHEN l->>'createdAt' = ${createdAt} THEN l || ${JSON.stringify({ state })}::jsonb ELSE l END)
          FROM jsonb_array_elements(letters) AS l
        ),
        updated_at = now()
        WHERE user_key = ${userKey}`
  );
}

/**
 * 记录今日一签（pickDaily 去重依据，"同一用户 90 天不重复"）。
 * 幂等：同一天只记一条（journey 页每次渲染都会调）；超过 90 条从最旧裁。
 * （jsonb 不支持切片下标，用 WITH ORDINALITY + LIMIT。）
 */
export async function recordDailySeen(userKey: string, date: string, text: string): Promise<void> {
  await execWithFailover((sql: SqlClient) =>
    sql`UPDATE growth_profiles
        SET daily_seen = (
          SELECT COALESCE(jsonb_agg(x ORDER BY ord), daily_seen)
          FROM (
            SELECT x, ord FROM jsonb_array_elements(
              CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(daily_seen) e WHERE e->>'date' = ${date})
                   THEN daily_seen
                   ELSE daily_seen || ${JSON.stringify([{ date, text }])}::jsonb END
            ) WITH ORDINALITY AS t(x, ord)
            ORDER BY ord DESC
            LIMIT 90
          ) last_n
        ),
        updated_at = now()
        WHERE user_key = ${userKey}`
  );
}

/**
 * 活跃足迹：当日任一动作（会话/微行动/日记）完成时 +1。
 * 单条 UPDATE 条件原子判断（last_active_date != today），天然幂等。
 * 「仅查看一签不算」——防打开首页即计活跃导致指标虚高（docs/02 §11）。
 */
export async function bumpActiveDay(userKey: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await execWithFailover((sql: SqlClient) =>
    sql`UPDATE growth_profiles
        SET total_active_days = total_active_days + 1,
            last_active_date = ${today},
            updated_at = now()
        WHERE user_key = ${userKey}
          AND (last_active_date IS NULL OR last_active_date <> ${today})`
  );
}
