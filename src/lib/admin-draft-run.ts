// AI 起草执行体（从 api/admin/draft 路由抽出，2026-09-22）：同步路由与后台任务
// （admin-draft-job）共用这一份。生成/守卫/写盘全在这里，路由只做鉴权与状态码映射。
// 管理员闸在路由层先行（未授权流量不触发 LLM）；这里假定调用方已过闸。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { BOOKS_DIR, readAdminBook, writeAdminBook, type AdminBookState } from '@/lib/admin-content';
import { recognizeBook, type BookRecognition } from '@/lib/admin-recognize';
import {
  buildDailyBatchNote,
  buildDailySystem,
  buildDailyUser,
  buildDailyUserNoMaterial,
  buildEnDailySystem,
  buildEnJourneySystem,
  buildJourneySystem,
  buildJourneyUser,
  buildJourneyUserNoMaterial,
  buildLampsSystem,
  buildLampsUser,
  draftToDaily,
  draftToLamps,
  draftToStages,
  validateDraftDaily,
  validateDraftDailyChunk,
  validateDraftJourney,
  validateDraftLamps,
  type DraftDailyCard,
  type DraftLamp,
  type DraftStage,
} from '@/lib/admin-draft';
import { llmCompleteJson } from '@/lib/llm';

const LLM_TIMEOUT_MS = 120_000;
/** 一签池分批：每批目标条数（模型单次输出 ~3k token 就收尾，90 条一次给不出——拆 3 批） */
const DAILY_BATCH = 30;
const DAILY_BATCHES = 3;

export type DraftStepError = 'book_not_found' | 'book_is_active' | 'book_unknown' | 'draft_invalid' | 'llm_failed';

export interface DraftStepResult {
  ok: boolean;
  error?: DraftStepError;
  /** draft_invalid 时的环节名（daily-batch2 / journey-en……） */
  stage?: string;
  log: string[];
  state?: AdminBookState;
}

/** 两次机会：LLM 出 JSON → 校验；不过关重来一次（assess 同款模式） */
async function generateWithRetry<T>(
  purpose: string,
  userKey: string,
  maxTokens: number,
  build: () => { system: string; user: string },
  validate: (raw: unknown) => string[],
): Promise<{ value: T; errors: string[] }> {
  let lastErrors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const { system, user } = build(); // 重试时重拼（把失败反馈加进去）
    const raw = await llmCompleteJson<T>({
      system,
      messages: [{ role: 'user', content: attempt === 0 ? user : `${user}\n\n上一次输出未通过校验：\n${lastErrors.map((e) => `- ${e}`).join('\n')}\n请修正后重新输出完整 JSON。` }],
      maxTokens,
      temperature: 0.4,
      timeoutMs: LLM_TIMEOUT_MS,
      callPurpose: purpose,
      userKey,
    });
    if (raw === null) {
      lastErrors = ['LLM 输出不是合法 JSON'];
      continue;
    }
    const errors = validate(raw);
    if (errors.length === 0) return { value: raw, errors: [] };
    lastErrors = errors;
  }
  return { value: null as T, errors: lastErrors };
}

/** v1 书的范例（学口吻不抄内容） */
function v1Exemplars(): { journey: string; lamps: string; daily: string } {
  const fallback = { journey: '（范例缺失）', lamps: '（范例缺失）', daily: '（范例缺失）' };
  try {
    const journeyDir = join(BOOKS_DIR, 'money-freedom', 'zh-CN', 'journey');
    const first = `1-看见.md`;
    const journeyPath = join(journeyDir, first);
    const journey = readFileSync(journeyPath, 'utf8');
    const lampsRaw = readFileSync(join(BOOKS_DIR, 'money-freedom', 'lamps.md'), 'utf8');
    const { data } = matter(lampsRaw);
    const sample = {
      stages: Object.fromEntries(
        Object.entries((data.stages ?? {}) as Record<string, unknown>)
          .slice(0, 1)
          .map(([k, v]) => [k, Array.isArray(v) ? v.slice(0, 2) : v]),
      ),
    };
    const pool: unknown = JSON.parse(readFileSync(join(BOOKS_DIR, 'money-freedom', 'zh-CN', 'daily', 'pool.json'), 'utf8'));
    const daily = Array.isArray(pool) ? pool.slice(0, 4) : [];
    return { journey, lamps: matter.stringify('', sample), daily: JSON.stringify(daily, null, 1) };
  } catch {
    return fallback;
  }
}

/**
 * 跑一次起草（kind = journey 含灯表 ｜ daily 一签池）。守卫与识别闸都在这里，
 * 失败以 {ok:false, error} 返回，不抛异常。onLog 用于后台任务的实时进度。
 * confirm（2026-09-23 管理员确认闸）：前端探针识别过、管理员点过确认后带来的载荷——
 * 无素材路径有了它就不再烧一次识别调用；没有它仍走原识别闸（服务端兜底）。
 */
export async function runDraftStep(
  bookId: string,
  kind: 'journey' | 'daily',
  source: string | undefined,
  email: string,
  onLog?: (line: string) => void,
  root: string = BOOKS_DIR,
  confirm?: BookRecognition,
): Promise<DraftStepResult> {
  const log: string[] = [];
  // 每一行日志都从这里走：同步路由拿返回的 log 数组，后台任务靠 onLog 实时流——两边同源不重复
  const say = (line: string): void => {
    log.push(line);
    onLog?.(line);
  };

  const state = readAdminBook(bookId, root);
  if (!state) return { ok: false, error: 'book_not_found', log };
  if (state.meta.status === 'active') {
    say('active 书的线上内容不许被 AI 覆盖；要重写先把 status 改回 draft（会先下线这本书）。');
    return { ok: false, error: 'book_is_active', log };
  }

  // 素材随请求带过来就先用（避免「先保存再起草」的顺序坑）。
  // ≥50 字符走素材路径；不足则按书名 + AI 对本书的理解起草（红线：原创标尺、不编造原文）。
  const material = typeof source === 'string' && source.trim() ? source : state.source;
  const useMaterial = material.trim().length >= 50;

  // 识别闸（用户 2026-09-22 拍板「除非 AI 找不到该书本」）：无素材起草前先确认
  // AI 真的认识这本书——不认识就拒绝（不硬编通用内容冒充那本书）。
  // 2026-09-23 起正常路径是：探针先识别 → 管理员确认卡确认 → confirm 带进来直通；
  // 没有 confirm（旧同步路由 / 非常规调用）仍走闸，known:false 照拒（防御纵深）。
  if (!useMaterial) {
    if (confirm && confirm.known === true) {
      const t = confirm.title || state.meta.title['zh-CN'] || bookId;
      const parts = [confirm.author && `作者 ${confirm.author}`, confirm.coreMethod && `核心：${confirm.coreMethod}`]
        .filter(Boolean)
        .join('，');
      say(`AI 识别（管理员已确认）：《${t}》${parts ? `，${parts}` : ''}`);
    } else {
      const rec = await recognizeBook(state.meta.title['zh-CN'] || bookId, state.meta.author, email);
      if (!rec.known) {
        say(`AI 不认识《${state.meta.title['zh-CN'] || bookId}》${rec.note ? `：${rec.note}` : ''}——拒绝凭空生成。`);
        say('两条路：① 素材框贴这本书的摘录/要点再起草；② 核对 meta 里的书名/作者后重试。');
        return { ok: false, error: 'book_unknown', log };
      }
      const desc = [rec.author && `作者 ${rec.author}`, rec.coreMethod && `核心：${rec.coreMethod}`, rec.note]
        .filter(Boolean)
        .join('，');
      if (desc) say(`AI 识别：${desc}`);
    }
  }

  try {
    // ---- 一签池起草：zh-CN 分 3 批 × 30 条 → 合并全量校验 → en 逐批翻译 → 写回 ----
    if (kind === 'daily') {
      const exemplars = v1Exemplars();
      const title = state.meta.title['zh-CN'] || bookId;
      const cardsZh: DraftDailyCard[] = [];
      for (let batch = 0; batch < DAILY_BATCHES; batch++) {
        const res = await generateWithRetry<{ cards: DraftDailyCard[] }>(
          'admin_draft_daily', email, 8000,
          () => ({
            system: buildDailySystem(exemplars.daily),
            user: `${useMaterial ? buildDailyUser(material, title) : buildDailyUserNoMaterial(title)}\n\n${buildDailyBatchNote(
              batch,
              cardsZh.slice(-DAILY_BATCH).map((c) => c.text),
            )}`,
          }),
          validateDraftDailyChunk,
        );
        if (res.errors.length > 0) {
          res.errors.forEach((e) => say(`第 ${batch + 1} 批未过校验：${e}`));
          return { ok: false, error: 'draft_invalid', stage: `daily-batch${batch + 1}`, log };
        }
        cardsZh.push(...res.value.cards);
        say(`一签池 zh-CN 第 ${batch + 1}/${DAILY_BATCHES} 批：${res.value.cards.length} 条（累计 ${cardsZh.length}）`);
      }
      const zhFull = validateDraftDaily({ cards: cardsZh });
      if (zhFull.length > 0) {
        zhFull.forEach((e) => say(`合并后未过全量校验：${e}`));
        return { ok: false, error: 'draft_invalid', stage: 'daily', log };
      }
      say(`一签池 zh-CN：${cardsZh.length} 条 ✅`);

      const cardsEn: DraftDailyCard[] = [];
      for (let batch = 0; batch < DAILY_BATCHES; batch++) {
        const slice = cardsZh.slice(batch * DAILY_BATCH, (batch + 1) * DAILY_BATCH);
        const res = await generateWithRetry<{ cards: DraftDailyCard[] }>(
          'admin_draft_daily_translate', email, 8000,
          () => ({
            system: buildEnDailySystem(),
            user:
              'Translate this batch of daily cards to English. Output the full JSON with "cards":\n' +
              JSON.stringify({ cards: slice }) +
              `\n\nThis is batch ${batch + 1}/${DAILY_BATCHES}; translate exactly these ${slice.length} cards.`,
          }),
          validateDraftDailyChunk,
        );
        if (res.errors.length > 0) {
          res.errors.forEach((e) => say(`en 第 ${batch + 1} 批未过校验：${e}`));
          return { ok: false, error: 'draft_invalid', stage: `daily-en-batch${batch + 1}`, log };
        }
        cardsEn.push(...res.value.cards);
        say(`一签池 en 第 ${batch + 1}/${DAILY_BATCHES} 批：${res.value.cards.length} 条（累计 ${cardsEn.length}）`);
      }
      const enFull = validateDraftDaily({ cards: cardsEn });
      if (enFull.length > 0) {
        enFull.forEach((e) => say(`en 合并后未过全量校验：${e}`));
        return { ok: false, error: 'draft_invalid', stage: 'daily-en', log };
      }
      say(`一签池 en：${cardsEn.length} 条 ✅`);

      const next = readAdminBook(bookId, root);
      if (!next) return { ok: false, error: 'book_not_found', log };
      next.daily = { 'zh-CN': draftToDaily(cardsZh), en: draftToDaily(cardsEn) };
      writeAdminBook(bookId, next, root);
      return { ok: true, log, state: next };
    }

    // ---- journey + 灯表起草：① zh-CN journey → ② 灯表（四语）→ ③ en journey（翻译）----
    const exemplars = v1Exemplars();
    // ① zh-CN journey
    const journeyResult = await generateWithRetry<{ stages: DraftStage[] }>(
      'admin_draft_journey', email, 8000,
      () => ({
        system: buildJourneySystem(exemplars.journey),
        user: useMaterial
          ? buildJourneyUser(material, state.meta.title['zh-CN'] || bookId, state.meta.author)
          : buildJourneyUserNoMaterial(state.meta.title['zh-CN'] || bookId, state.meta.author),
      }),
      validateDraftJourney,
    );
    if (journeyResult.errors.length > 0) {
      journeyResult.errors.forEach((e) => say(`journey 未过校验：${e}`));
      return { ok: false, error: 'draft_invalid', stage: 'journey', log };
    }
    const journeyZh = journeyResult.value.stages;
    say(`journey zh-CN：${journeyZh.length} 段 ✅`);

    // ② 灯表（四语一次给齐；拿 ① 的摘要当上下文）
    const lampsResult = await generateWithRetry<{ stages: Record<string, DraftLamp[]> }>(
      'admin_draft_lamps', email, 6000,
      () => ({
        system: buildLampsSystem(exemplars.lamps),
        user: buildLampsUser(journeyZh, bookId.replace(/-/g, '')),
      }),
      (raw) => validateDraftLamps(raw, bookId),
    );
    if (lampsResult.errors.length > 0) {
      lampsResult.errors.forEach((e) => say(`灯表未过校验：${e}`));
      return { ok: false, error: 'draft_invalid', stage: 'lamps', log };
    }
    say(`灯表：${Object.values(lampsResult.value.stages).reduce((n, r) => n + (Array.isArray(r) ? r.length : 0), 0)} 盏（四语齐）✅`);

    // ③ en journey（翻译 ①）
    const enResult = await generateWithRetry<{ stages: DraftStage[] }>(
      'admin_draft_translate', email, 8000,
      () => ({
        system: buildEnJourneySystem(),
        user: 'Translate this journey draft to English. Output the full JSON with "stages":\n' + JSON.stringify({ stages: journeyZh }),
      }),
      validateDraftJourney,
    );
    if (enResult.errors.length > 0) {
      enResult.errors.forEach((e) => say(`journey en 未过校验：${e}`));
      return { ok: false, error: 'draft_invalid', stage: 'journey-en', log };
    }
    say('journey en：4 段 ✅');

    // 写回：草稿只覆盖 journey + lamps（zh-CN 与 en）；meta / source / 一签不动
    const next = readAdminBook(bookId, root);
    if (!next) return { ok: false, error: 'book_not_found', log };
    next.journey['zh-CN'] = draftToStages(journeyZh);
    next.journey.en = draftToStages(enResult.value.stages);
    next.lamps = draftToLamps(lampsResult.value.stages);
    writeAdminBook(bookId, next, root);

    return { ok: true, log, state: next };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    say(`LLM 调用失败：${message}`);
    return { ok: false, error: 'llm_failed', log };
  }
}
