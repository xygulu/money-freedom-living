// 成长档案（growth_profiles）读写层。JSON 字段整体读写：
// 单用户并发极低（一个人和自己聊），读-改-写可接受；行级锁靠 UPDATE 的
// WHERE user_key 语义兜底，不引入额外乐观锁复杂度。
import { ensureSchema, execWithFailover, iso, type SqlClient } from '@/lib/db';
import { stageAdvanceTarget } from '@/lib/stage';
import { track } from '@/lib/analytics';
import { DEFAULT_BOOK_ID, type TopicId } from '@/lib/content';

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
  createdAt?: string; // 本版生成时刻（ISO）。v1 存量用户无此字段，演进基线兜底用 profile.created_at
}

/** 关键对话摘要（带日期，双层记忆：会话结束写入 1-2 句轻摘要，下次对话立即可用） */
export interface SessionMemory {
  date: string; // YYYY-MM-DD
  text: string;
  sessionId?: string; // 产生本摘要的会话；存量条目无此字段——时间线渲染为不可点
}

/** 心印（docs/02 阶段仪式）：完成推进标志/进入新阶段时点亮。kind 结构化键，展示名走 i18n */
export interface Stamp {
  kind: string; // stage1_story / stage2_claim / stage3_seven / stage2_entered …（stage.ts 判定表）
  earnedAt: string; // ISO
}

/**
 * 画像演进状态（growth_profiles.portrait_evolution JSONB）。只存用户动作与锁，
 * 「是否该提议」不落库——journey 页渲染时用 shouldPropose 现算（阈值逻辑改了立即生效）。
 * ⚠️ 绝不能放进 portrait JSONB：calibrate 的 savePortrait 整体覆盖会把它抹掉。
 */
export interface PortraitEvolution {
  dismissedAt: string | null; // 用户点「暂不」的时刻（14 天冷却内不再亮）
  lastGeneratedAt: string | null; // 上次成功演进
  proposedSeenAt: string | null; // 提议卡首次展示时刻（每纪元一次，供埋点去重）
  generatingAt: string | null; // 演进进行中的非重入锁（3 分钟自过期）
}

/** 阶段评估的一次结果（stage_assessment JSONB 内）。评估的是用户实际表现出的
 *  认知与行为所处的位置，不是操作次数；灯点亮必须带依据（可追溯素材）。 */
export interface AssessmentLamp {
  kind: string;
  lit: boolean;
  /** 点亮的依据：引用用户原话或具体的事（lit=false 时为空串） */
  evidence: string;
}

export interface StageAssessment {
  /** 评估出的实际位置；服务端 clamp 到 [当前阶段, 当前阶段+1]，不倒退 */
  actualStage: number;
  /** 恰为评估时当前阶段的灯集 */
  lamps: AssessmentLamp[];
  /** 镜子式总结（第二人称，不评判不打分） */
  summary: string;
  /** 为什么是这里：用书的机制框架解释（早期场景→底色→旧脚本→现在的模式），引素材原话；镜子不是判决 */
  diagnosis: string;
  /** 离「一辈子不愁钱的活法」还有多远：以它为北极星的路标式描述，不恐吓不许诺 */
  distance: string;
  /** 下一步行动建议：2-3 个对齐本阶段练习方法的具体小步，今天就能开始 */
  actions: string[];
  /** 下一阶段在远处长什么样；已在门口时说明 */
  nextHint: string;
  assessedAt: string; // ISO
}

/**
 * 阶段评估状态（growth_profiles.stage_assessment JSONB）。只存用户动作、锁与
 * 评估结果；「是否该提议」不落库——journey 渲染时用 shouldOfferAssess 现算
 * （同 evolution 哲学）。⚠️ 绝不能放进 portrait JSONB：calibrate 的
 * savePortrait 整体覆盖会把它抹掉。
 */
export interface AssessmentState {
  /** 已生成待用户确认的一次评估 */
  pending: StageAssessment | null;
  /** 最近一次用户确认的评估（灯的依据长期居所） */
  confirmed: StageAssessment | null;
  /** 最近一次确认时刻 = 下次评估的素材基线 */
  confirmedAt: string | null;
  /** 「不是这样的/先不用」→ 冷却期内不再提议 */
  dismissedAt: string | null;
  /** 评估生成中的非重入锁（3 分钟自过期） */
  generatingAt: string | null;
  /** 提议卡首次展示时刻（每纪元一次，供埋点去重） */
  proposedSeenAt: string | null;
  /** M10 变化清单的对照基线：上一次确认的评估（confirm/advance 时由本次的旧 confirmed 移入） */
  previousConfirmed?: StageAssessment | null;
  /** M10 《我变了什么》缓存（forConfirmedAt 变了即重生成） */
  changeList?: ChangeListEntry | null;
  /** 变化清单生成的非重入锁（自过期） */
  changeListLockAt?: string | null;
}

/** M10 《我变了什么》变化清单缓存项：LLM 叙述段 + 其对应的确认时刻 */
export interface ChangeListEntry {
  text: string;
  generatedAt: string;
  forConfirmedAt: string;
}

/** 容忍 '{}'、null 与脏值——JSONB 默认 '{}'，读取侧唯一出入口 */
export function parseAssessmentState(raw: unknown): AssessmentState {
  // 必须是纯对象：数组也满足 typeof === 'object'，但取键全是 undefined——列被
  // 外部手工编辑成数组/字符串时会静默退化成「什么都没有」（评估报告凭空消失）。
  // 显式判型 + 告警，让损坏看得见（写入侧 saveAssessmentState 会自愈回对象）。
  if (Array.isArray(raw)) {
    console.warn('[profile] stage_assessment is an array (corrupted shape) — treated as empty state');
  }
  const o = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const asmt = (v: unknown): StageAssessment | null =>
    typeof v === 'object' && v !== null ? (v as StageAssessment) : null;
  const changeList =
    typeof o.changeList === 'object' && o.changeList !== null
      ? {
          text: str((o.changeList as Record<string, unknown>).text) ?? '',
          generatedAt: str((o.changeList as Record<string, unknown>).generatedAt) ?? '',
          forConfirmedAt: str((o.changeList as Record<string, unknown>).forConfirmedAt) ?? '',
        }
      : null;
  return {
    pending: asmt(o.pending),
    confirmed: asmt(o.confirmed),
    confirmedAt: str(o.confirmedAt),
    dismissedAt: str(o.dismissedAt),
    generatingAt: str(o.generatingAt),
    proposedSeenAt: str(o.proposedSeenAt),
    previousConfirmed: asmt(o.previousConfirmed),
    changeList,
    changeListLockAt: str(o.changeListLockAt),
  };
}

/** 容忍 '{}'、null 与脏值——JSONB 默认 '{}'，读取侧唯一出入口 */
export function parseEvolution(raw: unknown): PortraitEvolution {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const iso = (v: unknown): string | null =>
    typeof v === 'string' && v ? v : null;
  return {
    dismissedAt: iso(o.dismissedAt),
    lastGeneratedAt: iso(o.lastGeneratedAt),
    proposedSeenAt: iso(o.proposedSeenAt),
    generatingAt: iso(o.generatingAt),
  };
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

/** 一本书在这个人这里的状态（docs/05 §4.1 books[]）。当前书 = status==='active' 那条。 */
export interface BookEntry {
  bookId: string;
  status: 'active' | 'paused' | 'done';
  startedAt: string; // ISO
  /** 这本书内走到第几段（当前书以行级 stage 为唯一真源，读时覆盖，避免两处真源打架） */
  stage: number;
  stageStartedAt: string; // ISO
  finishedAt?: string;
}

/** 命题上的程度（跨书累加，永不重置——书可以换，走过的程度不会退回，docs/05 §3.2） */
export type ThreadDepth = 'seen' | 'replaced' | 'mastered';

/**
 * 认知层三个指标的落点（docs/10 P0-1）。**零新表**：全部挂在 threads[].evidence 上，
 * 靠这个 kind 区分。没有 kind 的是普通证据（存量数据与评估写入的那些）。
 * - `pause`   L5 停顿：他主动停下来看了自己一眼（「合」的第③问填了东西）
 * - `migrate` L4 迁移：他自己说出一个新做法/新解释，**且他亲手确认过**这是新的
 * - `regress` M 恢复时间的起点：说法掉回旧句式。**只记时间，绝不展示给用户看**
 */
export type EvidenceKind = 'pause' | 'migrate' | 'regress';

/** quote 必须是用户原话：交叉印证时要调得出「你上次是这么说的」，而不是复述我的话 */
export interface ThreadEvidence {
  at: string; // ISO
  bookId: string;
  source: 'chat' | 'journal' | 'letter' | 'experiment' | 'assessment' | 'close';
  quote: string;
  ref?: string;
  /** 认知层指标标记（docs/10 P0-1）；普通证据不带 */
  kind?: EvidenceKind;
}

export interface ThreadState {
  firstSeenAt: string;
  lastSeenAt: string;
  depth: ThreadDepth;
  evidence: ThreadEvidence[];
}

/** 触达层状态（docs/05 §4.1 touch）。emailOptIn 与敏感信息同意是两件事，分开记。 */
export interface TouchState {
  emailOptIn?: boolean;
  optInAt?: string;
  unsubToken?: string;
  lastSentAt?: string;
  /** 每个节点只发一次的凭据：{ D3: ISO, D7: ISO, … } */
  sentNodes?: Record<string, string>;
  lastOpenedAt?: string;
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
  stamps: Stamp[];
  evolution: PortraitEvolution;
  assessment: AssessmentState;
  /** 档案行创建时刻（ISO）——演进基线的最末兜底（无版本行/无 portrait.createdAt 时） */
  created_at: string;
  /** 今日一签去重：最近看过的签文（上限 90 条 ≈ 90 天不重复，docs/02 一签机制） */
  dailySeen: { date: string; text: string }[];
  payday: { type: 'monthly' | 'biweekly' | 'weekly'; day?: number } | null;
  total_active_days: number;
  last_active_date: string | null;
  /** M11-A：读过/在读的书。存量档案读时归位成一条 v1 书，不写迁移脚本 */
  books: BookEntry[];
  /** M11-A：命题线（用户 × 命题），跨书累加 */
  threads: Partial<Record<TopicId, ThreadState>>;
  /** M11-E：触达层状态 */
  touch: TouchState;
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

/**
 * books 归位（docs/05 §4.1「存量归位不写迁移脚本」）：
 * 档案里没有 books（存量用户/新建行）时，读时补一条 v1 书的 active 记录。
 * 当前书的段数以行级 stage / stage_started_at 为唯一真源——books[] 里 active 那条读时被覆盖，
 * 避免"书内进度"出现两处可写真源。
 */
export function parseBooks(value: unknown, stage: number, stageStartedAt: string, createdAt: string): BookEntry[] {
  const raw = Array.isArray(value) ? (value as Partial<BookEntry>[]) : [];
  const entries: BookEntry[] = raw
    .filter((b) => typeof b?.bookId === 'string' && b.bookId !== '')
    .map((b) => ({
      bookId: b.bookId as string,
      status: b.status === 'paused' || b.status === 'done' ? b.status : 'active',
      startedAt: typeof b.startedAt === 'string' ? b.startedAt : createdAt,
      stage: typeof b.stage === 'number' ? b.stage : 1,
      stageStartedAt: typeof b.stageStartedAt === 'string' ? b.stageStartedAt : createdAt,
      ...(typeof b.finishedAt === 'string' ? { finishedAt: b.finishedAt } : {}),
    }));
  if (entries.length === 0) {
    entries.push({ bookId: DEFAULT_BOOK_ID, status: 'active', startedAt: createdAt, stage, stageStartedAt });
  }
  const active = entries.find((b) => b.status === 'active');
  if (active) {
    active.stage = stage;
    active.stageStartedAt = stageStartedAt;
  }
  return entries;
}

function parseThreads(value: unknown): GrowthProfile['threads'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: GrowthProfile['threads'] = {};
  for (const [topic, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const t = raw as Partial<ThreadState>;
    out[topic as TopicId] = {
      firstSeenAt: typeof t.firstSeenAt === 'string' ? t.firstSeenAt : '',
      lastSeenAt: typeof t.lastSeenAt === 'string' ? t.lastSeenAt : '',
      depth: t.depth === 'replaced' || t.depth === 'mastered' ? t.depth : 'seen',
      evidence: Array.isArray(t.evidence) ? (t.evidence as ThreadEvidence[]) : [],
    };
  }
  return out;
}

function parseTouch(value: unknown): TouchState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as TouchState;
}

/** 当前书（docs/05 §4.1：status==='active' 那本；存量/异常一律回落 v1 书） */
export function activeBook(profile: Pick<GrowthProfile, 'books'>): BookEntry | null {
  return profile.books.find((b) => b.status === 'active') ?? null;
}

export function activeBookId(profile: Pick<GrowthProfile, 'books'>): string {
  return activeBook(profile)?.bookId ?? DEFAULT_BOOK_ID;
}

function rowToProfile(row: Record<string, unknown>): GrowthProfile {
  const stage = row.stage as number;
  const stageStartedAt = iso(row.stage_started_at);
  const createdAt = iso(row.created_at);
  return {
    user_key: row.user_key as string,
    locale: row.locale as string,
    portrait: (row.portrait as Portrait | null) ?? null,
    concerns: (row.concerns as GrowthProfile['concerns']) ?? [],
    stage,
    stage_started_at: stageStartedAt,
    pinned: (row.pinned as GrowthProfile['pinned']) ?? [],
    memories: (row.memories as GrowthProfile['memories']) ?? [],
    experiments: (row.experiments as GrowthProfile['experiments']) ?? [],
    letters: (row.letters as GrowthProfile['letters']) ?? [],
    stamps: (row.stamps as GrowthProfile['stamps']) ?? [],
    evolution: parseEvolution(row.portrait_evolution),
    assessment: parseAssessmentState(row.stage_assessment),
    created_at: createdAt,
    dailySeen: (row.daily_seen as GrowthProfile['dailySeen']) ?? [],
    payday: (row.payday as GrowthProfile['payday']) ?? null,
    total_active_days: row.total_active_days as number,
    last_active_date: dateColumnToISO(row.last_active_date),
    books: parseBooks(row.books, stage, stageStartedAt, createdAt),
    threads: parseThreads(row.threads),
    touch: parseTouch(row.touch),
  };
}

export async function getProfile(userKey: string): Promise<GrowthProfile | null> {
  await ensureSchema();
  const rows = await execWithFailover((sql: SqlClient) =>
    sql`SELECT user_key, locale, portrait, concerns, stage, stage_started_at,
               pinned, memories, experiments, letters, stamps, portrait_evolution,
               stage_assessment, created_at, daily_seen, payday, total_active_days, last_active_date,
               books, threads, touch
        FROM growth_profiles WHERE user_key = ${userKey}`
  );
  const profile = rows[0] ? rowToProfile(rows[0]) : null;
  if (!profile) return null;
  // 程度制联动（含存量自愈）：确认评估里本阶段灯全亮 = 程度全达成 → 下一阶段
  // 自动开启，镜像 advance 语义（心印入档 + 埋点）。幂等——推进后灯集属新阶段，
  // 条件不再成立；并发请求各写一遍同值（心印 DISTINCT ON 去重）。
  const to = stageAdvanceTarget(profile, activeBookId(profile));
  if (to !== null) {
    await appendStamps(userKey, [`stage${to}_entered`]);
    await saveStage(userKey, to);
    await track(userKey, 'stage_advanced', { from: String(profile.stage), to: String(to), selfHeal: '1' }, profile.locale);
    profile.stage = to;
  }
  return profile;
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
                pinned, memories, experiments, letters, stamps, portrait_evolution,
                stage_assessment, created_at, daily_seen, payday, total_active_days, last_active_date,
                books, threads, touch
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
        SET memories = memories || ${JSON.stringify(fresh.map((e) => ({ date: e.date, text: e.text.trim(), ...(e.sessionId ? { sessionId: e.sessionId } : {}) })))}::jsonb,
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

/**
 * 心印点亮（M9 阶段进度）：评估确认/推进仪式时发（stamps 即灯的点亮真值）。
 * 按 kind 幂等——并发/重复触发不能重复入档。
 */
export async function appendStamps(userKey: string, kinds: string[]): Promise<void> {
  const valid = kinds.filter((k) => k.trim());
  const incoming = valid.map((k) => ({ kind: k, earnedAt: new Date().toISOString() }));
  // 单条 UPDATE 原子幂等：候选 = 现有 ++ 本次待颁，DISTINCT ON (kind) 只留首现
  // （原有元素的 earnedAt 自然保留）。此前的应用层 read-filter-write 不是原子的，
  // 双标签页/预取并发渲染会各自追加，写出重复 kind（React key 冲突的来源）；
  // 并发时后到者在行锁上等待，基于最新行版本计算，不会重复。
  // 空 kinds 不早退：确认时 newlyLit 常为空（灯早已入档），这正是清理历史
  // 重复行的时机——跳过会让「自愈存量」永远轮不到执行。
  await execWithFailover((sql: SqlClient) =>
    sql`UPDATE growth_profiles
        SET stamps = (
              SELECT coalesce(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
              FROM (
                SELECT DISTINCT ON (e->>'kind') e AS elem, ord
                FROM jsonb_array_elements(stamps || ${JSON.stringify(incoming)}::jsonb) WITH ORDINALITY AS t(e, ord)
                ORDER BY e->>'kind', ord
              ) first_per_kind
            ),
            updated_at = now()
        WHERE user_key = ${userKey}`
  );
}

/** 阶段推进（/api/journey/assess action=advance）：stage +1 且 stage_started_at 重置 */
export async function saveStage(userKey: string, stage: number): Promise<void> {
  await execWithFailover((sql: SqlClient) =>
    sql`UPDATE growth_profiles
        SET stage = ${stage}, stage_started_at = now(), updated_at = now()
        WHERE user_key = ${userKey}`
  );
}

// ───────────────────────── M11-A 命题线与触达（docs/05 §4.1/§4.6） ─────────────────────────

/** 每个命题最多留这么多条原话——交叉印证只需要"你上次是这么说的"，不需要全部历史 */
const THREAD_EVIDENCE_MAX = 20;

const DEPTH_RANK: Record<ThreadDepth, number> = { seen: 0, replaced: 1, mastered: 2 };

/** 程度只增不减（书可以换、灯可以是新书的，命题上走到的程度不回退——docs/05 §3.2） */
export function mergeDepth(current: ThreadDepth | undefined, incoming: ThreadDepth): ThreadDepth {
  if (!current) return incoming;
  return DEPTH_RANK[incoming] > DEPTH_RANK[current] ? incoming : current;
}

/**
 * 往命题线上记一条证据（quote 必须是用户原话）。
 * 写法：整块覆盖该 topic 的子对象，外层用 jsonb_typeof 守住——JSONB `||` 只有
 * "对象 + 对象"才是合并，NULL/数组会静默变成追加或抹平（0277200 的教训）。
 */
export async function recordThreadEvidence(
  userKey: string,
  topic: TopicId,
  evidence: ThreadEvidence,
  current: ThreadState | undefined,
  depth: ThreadDepth = 'seen',
): Promise<void> {
  const at = evidence.at || new Date().toISOString();
  const kept = [...(current?.evidence ?? []), { ...evidence, at }].slice(-THREAD_EVIDENCE_MAX);
  const state: ThreadState = {
    firstSeenAt: current?.firstSeenAt || at,
    lastSeenAt: at,
    depth: mergeDepth(current?.depth, depth),
    evidence: kept,
  };
  await execWithFailover((sql: SqlClient) =>
    sql`UPDATE growth_profiles
        SET threads = (CASE WHEN jsonb_typeof(threads) = 'object' THEN threads ELSE '{}'::jsonb END)
                      || jsonb_build_object(${topic}::text, ${JSON.stringify(state)}::jsonb),
            updated_at = now()
        WHERE user_key = ${userKey}`
  );
}

/**
 * 撤回一条证据（docs/10 P0-1 的 L4「不对，撤销」）。
 *
 * 为什么必须是**真删**而不是打个 dismissed 标记：这是「不诊断、不贴标签」红线的技术
 * 实现——AI 说"这是个新说法"，用户说"不是"，那就当没发生过。留一条"用户否认过的
 * 迁移"在库里，下次读取端照样会拿它做文章，等于把标签偷偷留下了。
 * 按 (topic, at) 精确定位：at 是写入时的 ISO 时间戳，同一命题上不会撞。
 */
export async function deleteThreadEvidence(userKey: string, topic: TopicId, at: string): Promise<void> {
  const profile = await getProfile(userKey);
  const current = profile?.threads?.[topic];
  if (!current) return;
  const kept = current.evidence.filter((e) => e.at !== at);
  if (kept.length === current.evidence.length) return;
  const state: ThreadState = { ...current, evidence: kept };
  await execWithFailover((sql: SqlClient) =>
    sql`UPDATE growth_profiles
        SET threads = (CASE WHEN jsonb_typeof(threads) = 'object' THEN threads ELSE '{}'::jsonb END)
                      || jsonb_build_object(${topic}::text, ${JSON.stringify(state)}::jsonb),
            updated_at = now()
        WHERE user_key = ${userKey}`
  );
}

/** 触达状态局部更新（同样守类型；调用方只传要改的键） */export async function saveTouch(userKey: string, patch: TouchState): Promise<void> {
  await execWithFailover((sql: SqlClient) =>
    sql`UPDATE growth_profiles
        SET touch = (CASE WHEN jsonb_typeof(touch) = 'object' THEN touch ELSE '{}'::jsonb END)
                    || ${JSON.stringify(patch)}::jsonb,
            updated_at = now()
        WHERE user_key = ${userKey}`
  );
}

/**
 * 节点发信的重发防护：只有该节点从未发过才写入并返回 true（单条 UPDATE 原子判断）。
 * 调度器据此决定要不要真的发——先占位再发，宁可漏发不可重发。
 */
export async function claimTouchNode(userKey: string, node: string): Promise<boolean> {
  const at = new Date().toISOString();
  const rows = await execWithFailover((sql: SqlClient) =>
    sql`UPDATE growth_profiles
        SET touch = (CASE WHEN jsonb_typeof(touch) = 'object' THEN touch ELSE '{}'::jsonb END)
                    || jsonb_build_object(
                         'lastSentAt', ${at}::text,
                         'sentNodes',
                         (CASE WHEN jsonb_typeof(touch->'sentNodes') = 'object' THEN touch->'sentNodes' ELSE '{}'::jsonb END)
                         || jsonb_build_object(${node}::text, ${at}::text)
                       ),
            updated_at = now()
        WHERE user_key = ${userKey}
          AND (touch->'sentNodes'->>${node}) IS NULL
        RETURNING user_key`
  );
  return rows.length > 0;
}

/**
 * 占位回滚：发信真的没发出去时，把 claimTouchNode 写下的那一笔撤掉。
 *
 * 不撤会怎样：占位是"宁可漏发不可重发"的一半，另一半得有人还回来。Resend 401 那一刻
 * 节点已经记成"发过了"，而信一个字都没出去——这个人从此永远收不到这个节点的信，
 * 而且没有任何地方会再提起它。漏一次可以，漏得无声无息不行。
 *
 * lastSentAt 也一并回退到"剩下的节点里最晚的那次"（节点时间戳是 ISO 串，字典序即时序）；
 * 一条都不剩就整个删掉，免得一个从没发出去的时间挡住后面的间隔闸。
 */
export async function releaseTouchNode(userKey: string, node: string): Promise<void> {
  await execWithFailover((sql: SqlClient) =>
    sql`WITH cur AS (
          SELECT user_key,
                 (CASE WHEN jsonb_typeof(touch->'sentNodes') = 'object' THEN touch->'sentNodes' ELSE '{}'::jsonb END)
                 - ${node}::text AS remaining
          FROM growth_profiles WHERE user_key = ${userKey}
        )
        UPDATE growth_profiles g
        SET touch = ((CASE WHEN jsonb_typeof(g.touch) = 'object' THEN g.touch ELSE '{}'::jsonb END) - 'lastSentAt')
                    || jsonb_build_object('sentNodes', cur.remaining)
                    || (SELECT CASE WHEN max(value) IS NULL THEN '{}'::jsonb
                                    ELSE jsonb_build_object('lastSentAt', max(value)) END
                        FROM jsonb_each_text(cur.remaining)),
            updated_at = now()
        FROM cur
        WHERE g.user_key = cur.user_key`
  );
}

/**
 * 按退订 token 反查用户（M11-E）：退订链接点进来时没有登录态，只能靠信里那串 token。
 * 空 token 一律不匹配——否则「touch 里没有 token 的行」会被一个空串全捞出来。
 */
export async function findUserKeyByUnsubToken(token: string): Promise<string | null> {
  if (!token.trim()) return null;
  const rows = await execWithFailover((sql: SqlClient) =>
    sql`SELECT user_key FROM growth_profiles
        WHERE touch->>'unsubToken' = ${token} LIMIT 1`
  );
  return rows[0] ? String(rows[0].user_key) : null;
}

/**
 * 调度器的候选集（M11-E）：只捞**已 opt-in** 的行，未同意的人连查询都不进——
 * 合规第一条（未 opt-in 收不到任何触达邮件）在 SQL 层就先关一道闸。
 * 真正发不发还要过 `pickTouchNode`（活跃度/间隔/节点是否发过），这里只做粗筛。
 */
export async function listTouchCandidates(limit = 500): Promise<GrowthProfile[]> {
  await ensureSchema();
  const rows = await execWithFailover((sql: SqlClient) =>
    sql`SELECT user_key, locale, portrait, concerns, stage, stage_started_at,
               pinned, memories, experiments, letters, stamps, portrait_evolution,
               stage_assessment, created_at, daily_seen, payday, total_active_days, last_active_date,
               books, threads, touch
        FROM growth_profiles
        WHERE touch->>'emailOptIn' = 'true'
          AND user_key LIKE 'u:%'
        ORDER BY created_at ASC
        LIMIT ${limit}`
  );
  return rows.map(rowToProfile);
}

/** 换书 / 开新书：把旧的当前书置为 paused（或 done），把目标书设为 active。 */
export async function saveBooks(userKey: string, books: BookEntry[]): Promise<void> {
  await execWithFailover((sql: SqlClient) =>
    sql`UPDATE growth_profiles
        SET books = ${JSON.stringify(books)}::jsonb, updated_at = now()
        WHERE user_key = ${userKey}`
  );
}
