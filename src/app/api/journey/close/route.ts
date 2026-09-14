// POST /api/journey/close —— 「合」的一格提交（docs/10 P0-1）。
//
// 一天只有一件事要做：做完那件事，回来交这一格。三行都可跳过（只有①必选，它是行为层
// 的全部）。这一格同时喂四个东西：即时见证（用户体验）、每日两问的落点（认知层）、
// L5/L4/M 三个指标、以及节点判断的原料（node_verdict）。
//
// 写下去的东西分两类，边界很硬：
// - **原话**（②③）只进 `growth_profiles.threads[].evidence` —— 导出/删号已经覆盖那里。
// - **事件**（`events`）只放枚举与指针（topic + at），**绝不放用户文本原文**（P§9 日志
//   纪律，docs/10 建议的 `basis=原话` 在这条纪律面前让路：指针一样能回溯到那句话）。
import { NextRequest } from 'next/server';
import { resolveIdentity } from '@/lib/identity';
import {
  activeBookId,
  bumpActiveDay,
  ensureProfile,
  getProfile,
  recordThreadEvidence,
  type ThreadEvidence,
} from '@/lib/profile';
import {
  FIRST_LINE_MAX,
  THOUGHT_MAX,
  classifyFirstLine,
  isDidToday,
  isPause,
  isVerdictNode,
  nodeVerdict,
  priorLines,
  topicForToday,
} from '@/lib/cognition';
import { checkSafety, recordSafetyEvent, referralMessage } from '@/lib/safety';
import { track } from '@/lib/analytics';
import { getLlmProviders, llmComplete } from '@/lib/llm';
import { buildReceiptSystem, buildCloseReceiptUser, pickReceiptFallback } from '@/lib/receipt';
import { enabledLocales, isLocale, type Locale } from '@/i18n/config';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      did?: string;
      thought?: string;
      firstLine?: string;
      firstLineSkipped?: boolean;
      node?: string;
      locale?: string;
    };
    if (!isDidToday(body.did)) return jsonError('bad_did', 400);
    const did = body.did;
    const thought = typeof body.thought === 'string' ? body.thought.trim().slice(0, THOUGHT_MAX) : '';
    const firstLine = typeof body.firstLine === 'string' ? body.firstLine.trim().slice(0, FIRST_LINE_MAX) : '';
    const skipped = body.firstLineSkipped === true;
    const locale: Locale = isLocale(body.locale) && enabledLocales.includes(body.locale) ? body.locale : 'en';

    const identity = await resolveIdentity(request);

    // 用户文本入口一律过安全层（P§8）：命中照常写入（用户的话就是用户的话），只是回应换成转介
    let safetyHit = false;
    const said = [thought, firstLine].filter(Boolean).join('\n');
    if (said) {
      const verdict = await checkSafety(locale, said);
      if (verdict.hit) {
        safetyHit = true;
        await recordSafetyEvent(identity.key, 'close', verdict.category ?? 'crisis');
      }
    }

    const profile = (await getProfile(identity.key)) ?? (await ensureProfile(identity.key, locale));
    const bookId = activeBookId(profile);
    const at = new Date().toISOString();
    const pause = isPause(firstLine, skipped);

    // ③ 填了 = 一次 L5 停顿。分类交给 AI（新说法 / 掉回旧句式 / 说不好），它同时告诉我们
    // 这句话落在哪条命题线上——判不了就回落到当前段那盏灯的命题，原话绝不因此丢掉。
    let verdictLine: 'new' | 'old' | 'unclear' = 'unclear';
    let topic = topicForToday(profile, bookId);
    let migration: { topic: string; quote: string } | null = null;
    if (pause) {
      if (getLlmProviders().length > 0) {
        const judged = await classifyFirstLine({ locale, firstLine, prior: priorLines(profile) });
        verdictLine = judged.verdict;
        topic = topicForToday(profile, bookId, judged.topic);
      }
      const evidence: ThreadEvidence = { at, bookId, source: 'close', quote: firstLine, kind: 'pause' };
      await recordThreadEvidence(identity.key, topic, evidence, profile.threads?.[topic]);
      await track(identity.key, 'cognition_pause', { topic }, locale);

      if (verdictLine === 'old') {
        // M 的起点。**不进界面、不通知、不提醒**——「你掉回去了」这句话产品里一个字都不出现
        const fresh = await getProfile(identity.key);
        await recordThreadEvidence(
          identity.key,
          topic,
          { at: new Date(Date.parse(at) + 1).toISOString(), bookId, source: 'close', quote: firstLine, kind: 'regress' },
          fresh?.threads?.[topic]
        );
        await track(identity.key, 'cognition_regress', { topic }, locale);
      } else if (verdictLine === 'new') {
        // L4 只提议，**不落库**：记不记是用户说了算（POST /api/journey/close/migrate）
        migration = { topic, quote: firstLine };
        await track(identity.key, 'cognition_migrate_proposed', { topic }, locale);
      }
    }

    try {
      await bumpActiveDay(identity.key);
    } catch (error) {
      console.error('[api/journey/close] bumpActiveDay failed:', error);
    }
    await track(identity.key, 'day_close_saved', { did, pause, safety: safetyHit, thought: Boolean(thought) }, locale);

    // 节点判断（docs/10 P0-2）：从节点信里回来的这一格，就是那个节点的答卷
    if (isVerdictNode(body.node)) {
      const nv = nodeVerdict({ did, pause });
      await track(
        identity.key,
        'node_verdict',
        {
          node: body.node,
          verdict: nv.verdict,
          behavior_ok: nv.behaviorOk,
          cognition_ok: nv.cognitionOk,
          // 依据指针（不是原话）：照 (topic, at) 能在 threads 里取回他说的那一句
          basis_topic: pause ? topic : null,
          basis_at: pause ? at : null,
          source: 'touch',
        },
        locale
      );
    }

    // 即时见证：用他自己的话回一句，不评价、不给结论。命中安全层→转介文案；
    // LLM 不可用→词典兜底。回应本身绝不阻塞记录（记录已经在上面完成了）。
    const fallback = pickReceiptFallback(locale, `${identity.key}#${at}`, did);
    let receipt = safetyHit ? referralMessage(locale, 'crisis') : fallback;
    if (!safetyHit && (thought || firstLine) && getLlmProviders().length > 0) {
      try {
        const raw = await llmComplete({
          system: buildReceiptSystem(locale),
          messages: [{ role: 'user', content: buildCloseReceiptUser({ did, thought, firstLine }) }],
          maxTokens: 200,
          temperature: 0.7,
        });
        const text = raw.trim();
        if (text) receipt = text;
      } catch (error) {
        console.error('[api/journey/close] receipt llm failed:', error);
      }
    }

    const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
    if (identity.newGuestCookie) headers['Set-Cookie'] = identity.newGuestCookie;
    return new Response(JSON.stringify({ ok: true, safety: safetyHit, receipt, migration, at }), { headers });
  } catch (error) {
    console.error('[api/journey/close] failed:', error);
    return jsonError('server_error', 500);
  }
}
