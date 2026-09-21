// 存量批量打标（V0.2 C4b，销 docs/02 §20.2 B3 的数据面）。
// 给一签池里缺 topics 的条目 + 缺 topics 的 practices 补 1-2 个命题标签。
// 只补缺：已有人工校正过的标签不动。打标不改文字，所以 active 书也允许（v1 本身就是 active）。
import { requireApiAdmin } from '@/lib/admin-auth';
import { PRACTICES_DIR, readAdminBook, readPracticeNotes, writeAdminBook, writePracticeTopics } from '@/lib/admin-content';
import { buildDailyTaggingUser, buildPracticeTaggingUser, buildTaggingSystem, validateTagAssignments } from '@/lib/admin-draft';
import { llmCompleteJson } from '@/lib/llm';

const LLM_TIMEOUT_MS = 120_000;

export async function POST(request: Request) {
  const gate = await requireApiAdmin();
  if (!gate.ok) return gate.response;

  const body = (await request.json().catch(() => null)) as { bookId?: string } | null;
  const bookId = String(body?.bookId ?? '');
  if (!bookId || bookId.includes('..') || bookId.includes('/')) {
    return Response.json({ ok: false, error: 'bad_book_id' }, { status: 400 });
  }

  const state = readAdminBook(bookId);
  if (!state) return Response.json({ ok: false, error: 'book_not_found' }, { status: 404 });

  const log: string[] = [];
  let changed = false;

  try {
    // ① 一签池（zh-CN + en 两池，只补缺 topics 的条目）
    const next = readAdminBook(bookId)!;
    for (const locale of ['zh-CN', 'en'] as const) {
      const missing = next.daily[locale].filter((c) => c.topics.length === 0);
      if (missing.length === 0) {
        log.push(`一签 ${locale}：无缺标，跳过`);
        continue;
      }
      const result = await tagWithRetry(
        'admin_tag_daily', gate.email, 4000,
        (feedback) => buildDailyTaggingUser(missing.map((c) => ({ text: c.text, type: c.type, reflection: c.reflection }))) + feedback,
        missing.length,
      );
      if (result.errors.length > 0) {
        return Response.json({ ok: false, error: 'tag_invalid', stage: `daily-${locale}`, log: [...log, ...result.errors] }, { status: 502 });
      }
      let cursor = 0;
      next.daily[locale] = next.daily[locale].map((c) =>
        c.topics.length === 0 ? { ...c, topics: result.assignments[cursor++]?.topics ?? [] } : c,
      );
      log.push(`一签 ${locale}：补标 ${missing.length} 条 ✅`);
      changed = true;
    }
    if (changed) writeAdminBook(bookId, next);

    // ② practices（书外共享，只补缺 topics 的篇目）
    const notes = readPracticeNotes(PRACTICES_DIR);
    const missingNotes = notes.filter((n) => n.topics.length === 0);
    if (missingNotes.length > 0) {
      const result = await tagWithRetry(
        'admin_tag_practices', gate.email, 2000,
        (feedback) => buildPracticeTaggingUser(missingNotes) + feedback,
        missingNotes.length,
      );
      if (result.errors.length > 0) {
        return Response.json({ ok: false, error: 'tag_invalid', stage: 'practices', log: [...log, ...result.errors] }, { status: 502 });
      }
      missingNotes.forEach((n, i) => writePracticeTopics(n.file, result.assignments[i]?.topics ?? []));
      log.push(`practices：补标 ${missingNotes.length} 篇 ✅`);
      changed = true;
    } else {
      log.push('practices：无缺标，跳过');
    }

    if (!changed) log.push('没有需要补标的内容。');
    return Response.json({ ok: true, log, state: readAdminBook(bookId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ ok: false, error: 'llm_failed', log: [...log, `LLM 调用失败：${message}`] }, { status: 502 });
  }
}

/** 打标：两次机会，重试时把校验错误清单喂回 prompt（assess/C4a 同款模式） */
async function tagWithRetry(
  purpose: string,
  userKey: string,
  maxTokens: number,
  buildUser: (feedback: string) => string,
  count: number,
): Promise<{ errors: string[]; assignments: ReturnType<typeof validateTagAssignments>['assignments'] }> {
  let lastErrors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const feedback = attempt === 0 ? '' : `\n\n上一次输出未通过校验：\n${lastErrors.map((e) => `- ${e}`).join('\n')}\n请修正后重新输出完整 JSON。`;
    const raw = await llmCompleteJson<{ tags: unknown }>({
      system: buildTaggingSystem(),
      messages: [{ role: 'user', content: buildUser(feedback) }],
      maxTokens,
      temperature: 0.3,
      timeoutMs: LLM_TIMEOUT_MS,
      callPurpose: purpose,
      userKey,
    });
    if (raw === null) {
      lastErrors = ['LLM 输出不是合法 JSON'];
      continue;
    }
    const { errors, assignments } = validateTagAssignments(raw, count);
    if (errors.length === 0) return { errors: [], assignments };
    lastErrors = errors;
  }
  return { errors: lastErrors, assignments: [] };
}
