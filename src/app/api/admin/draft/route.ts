// AI 起草整包（V0.2 C4a：journey zh-CN + 灯表四语 + journey en）。
// 管理员闸 → （可选先存素材）→ 三次 LLM 调用各带「校验失败重试一次」→
// 草稿写回 content/books/<id>/（draft 书本就不上线，发布走 C2 闸）。
// 只允许对 status: draft 的书起草——active 书的线上内容不许被 AI 覆盖。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { requireApiAdmin } from '@/lib/admin-auth';
import { BOOKS_DIR, readAdminBook, writeAdminBook } from '@/lib/admin-content';
import {
  buildEnJourneySystem,
  buildJourneySystem,
  buildJourneyUser,
  buildLampsSystem,
  buildLampsUser,
  draftToLamps,
  draftToStages,
  validateDraftJourney,
  validateDraftLamps,
  type DraftLamp,
  type DraftStage,
} from '@/lib/admin-draft';
import { llmCompleteJson } from '@/lib/llm';

const LLM_TIMEOUT_MS = 120_000;

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
function v1Exemplars(): { journey: string; lamps: string } {
  const fallback = { journey: '（范例缺失）', lamps: '（范例缺失）' };
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
    return { journey, lamps: matter.stringify('', sample) };
  } catch {
    return fallback;
  }
}

export async function POST(request: Request) {
  const gate = await requireApiAdmin();
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => null)) as { bookId?: string; source?: string } | null;
  const bookId = String(body?.bookId ?? '');
  if (!bookId || bookId.includes('..') || bookId.includes('/')) {
    return Response.json({ ok: false, error: 'bad_book_id' }, { status: 400 });
  }

  const state = readAdminBook(bookId);
  if (!state) return Response.json({ ok: false, error: 'book_not_found' }, { status: 404 });
  if (state.meta.status === 'active') {
    return Response.json({ ok: false, error: 'book_is_active', log: 'active 书的线上内容不许被 AI 覆盖；要重写先把 status 改回 draft（会先下线这本书）。' }, { status: 409 });
  }

  // 素材随请求带过来就先存（避免「先保存再起草」的顺序坑）
  const material = typeof body?.source === 'string' && body.source.trim() ? body.source : state.source;
  if (material.trim().length < 50) {
    return Response.json({ ok: false, error: 'material_too_short', log: '素材太少（<50 字符）——先把书的摘录/要点贴进素材框。' }, { status: 400 });
  }

  const exemplars = v1Exemplars();
  const log: string[] = [];

  try {
    // ① zh-CN journey
    const journeyResult = await generateWithRetry<{ stages: DraftStage[] }>(
      'admin_draft_journey', gate.email, 8000,
      () => ({
        system: buildJourneySystem(exemplars.journey),
        user: buildJourneyUser(material, state.meta.title['zh-CN'] || bookId, state.meta.author),
      }),
      validateDraftJourney,
    );
    if (journeyResult.errors.length > 0) {
      return Response.json({ ok: false, error: 'draft_invalid', stage: 'journey', log: journeyResult.errors }, { status: 502 });
    }
    const journeyZh = journeyResult.value.stages;
    log.push(`journey zh-CN：${journeyZh.length} 段 ✅`);

    // ② 灯表（四语一次给齐；拿 ① 的摘要当上下文）
    const lampsResult = await generateWithRetry<{ stages: Record<string, DraftLamp[]> }>(
      'admin_draft_lamps', gate.email, 6000,
      () => ({
        system: buildLampsSystem(exemplars.lamps),
        user: buildLampsUser(journeyZh, bookId.replace(/-/g, '')),
      }),
      (raw) => validateDraftLamps(raw, bookId),
    );
    if (lampsResult.errors.length > 0) {
      return Response.json({ ok: false, error: 'draft_invalid', stage: 'lamps', log: lampsResult.errors }, { status: 502 });
    }
    log.push(`灯表：${Object.values(lampsResult.value.stages).reduce((n, r) => n + (Array.isArray(r) ? r.length : 0), 0)} 盏（四语齐）✅`);

    // ③ en journey（翻译 ①）
    const enResult = await generateWithRetry<{ stages: DraftStage[] }>(
      'admin_draft_translate', gate.email, 8000,
      () => ({
        system: buildEnJourneySystem(),
        user: 'Translate this journey draft to English. Output the full JSON with "stages":\n' + JSON.stringify({ stages: journeyZh }),
      }),
      validateDraftJourney,
    );
    if (enResult.errors.length > 0) {
      return Response.json({ ok: false, error: 'draft_invalid', stage: 'journey-en', log: enResult.errors }, { status: 502 });
    }
    log.push('journey en：4 段 ✅');

    // 写回：草稿只覆盖 journey + lamps（zh-CN 与 en）；meta / source / 一签不动
    const next = readAdminBook(bookId);
    if (!next) return Response.json({ ok: false, error: 'book_not_found' }, { status: 404 });
    next.journey['zh-CN'] = draftToStages(journeyZh);
    next.journey.en = draftToStages(enResult.value.stages);
    next.lamps = draftToLamps(lampsResult.value.stages);
    writeAdminBook(bookId, next);

    // 回带最新工作台态：前端直接 setState，不用靠 router.refresh 重挂
    return Response.json({ ok: true, log, state: next });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.push(`LLM 调用失败：${message}`);
    return Response.json({ ok: false, error: 'llm_failed', log }, { status: 502 });
  }
}
