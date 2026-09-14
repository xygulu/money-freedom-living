// POST /api/companion/nudge —— 取一条陪伴者 nudge 文案（前台改造 §6）。
//
// 入参：无（cookie + 用户档案自取）
// 出参：{ text: string, source: 'template-memory' | 'template-goal' | 'template-promise' | 'llm' | 'fallback', hitRedLine: boolean }
//
// 安全闸：safety 命中（crisis/DV）→ 返回 fallback，不展示；路由不主动 throw，避免暴露分类。
// 频次闸：路由**不**控制——客户端 24h 闸（cookie + localStorage）在外层 Companion 组件里。
//   这是设计：nudge 是产品机制，不是数据；频次闸是 UX 关心，不是合规关心。
// 埋点：每次访问写一条 companion_nudge_events（user_key, source, stage, hit_red_line, dismissed_within_30s=false, led_to_chat_open=false）。
//   dismissed_within_30s 与 led_to_chat_open 由后续 client 事件回传，本路由写默认值 false。
import { NextResponse } from 'next/server';
import { cookies, headers } from 'next/headers';
import { resolveIdentity } from '@/lib/identity';
import { getDict } from '@/i18n/get-dict';
import { getProfile, activeBookId } from '@/lib/profile';
import { getJourneyStage } from '@/lib/content';
import { buildCompanionNudge, type NudgeSource } from '@/lib/companion-nudge';
import { execWithFailover, ensureSchema } from '@/lib/db';
import { defaultLocale } from '@/i18n/config';

export const dynamic = 'force-dynamic';

interface CompanionNudgeResponse {
  text: string;
  source: NudgeSource;
  hitRedLine: boolean;
}

/** 从用户档案里抓 L1 三档要用的素材；返回 null = 跳过该档 */
function pickNudgeMaterial(profile: NonNullable<Awaited<ReturnType<typeof getProfile>>>) {
  // L1a：最近一条 memory 摘要（用户自己的原话，≥1 句）
  const lastMemory =
    profile.memories.length > 0
      ? profile.memories[profile.memories.length - 1]
      : null;
  const lastMemoryText = lastMemory?.text?.trim() || null;

  // L1b：当前阶段的 goal（书的阶段目标，可为 null）
  const stageGoal = getJourneyStage(
    profile.locale as Parameters<typeof getJourneyStage>[0],
    profile.stage,
    activeBookId(profile),
  )?.goal ?? null;

  // L1c：最近一条 promise/open/last letter 内容
  // promise 优先（具体承诺比开放性承诺更"想试"）；其次 open（明确的"想试"），
  // 最后 letter 内容（最近一封信的主题词）。promise/open 都空时用 letters[last].content。
  const latestPromise = [...profile.pinned].reverse().find((p) => p.kind === 'promise' && p.text?.trim());
  const latestOpen = [...profile.pinned].reverse().find((p) => p.kind === 'open' && p.text?.trim());
  const latestLetter = profile.letters.length > 0 ? profile.letters[profile.letters.length - 1] : null;
  const lastTouchedPrompt =
    latestPromise?.text?.trim() ||
    latestOpen?.text?.trim() ||
    latestLetter?.content?.trim() ||
    null;

  return { lastMemoryText, stageGoal, lastTouchedPrompt };
}

export async function POST(): Promise<NextResponse> {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const identity = await resolveIdentity({
    headers: headerStore,
    cookies: { get: (name: string) => cookieStore.get(name) },
  });

  // 用户没有档案（极早期 cookie 流失场景）→ 直接兜底，不查 stage/memory
  const profile = await getProfile(identity.key);
  const locale = (profile?.locale as Parameters<typeof buildCompanionNudge>[0]['locale']) || defaultLocale;
  const dict = await getDict(locale);
  const fallback = dict.nudge?.fallback ?? '我在这儿。';

  if (!profile) {
    const responseHeaders: Record<string, string> = {};
    if (identity.newGuestCookie) responseHeaders['Set-Cookie'] = identity.newGuestCookie;
    return NextResponse.json<CompanionNudgeResponse>(
      { text: fallback, source: 'fallback', hitRedLine: false },
      Object.keys(responseHeaders).length > 0 ? { headers: responseHeaders } : undefined,
    );
  }

  const { lastMemoryText, stageGoal, lastTouchedPrompt } = pickNudgeMaterial(profile);

  // MVP：不接 LLM 路径（allowLlm 默认 false）—— L1 三档已覆盖绝大多数用户；
  // 未来真要打开 LLM，先在 docs/08 登记偏离 + 走 safety 全链路，再开 allowLlm=true。
  const out = await buildCompanionNudge({
    locale,
    lastMemoryText,
    stageGoal,
    lastTouchedPrompt,
    safetyBlocked: false, // MVP 不接 safetyEvents 扫描，留白
    fallback,
  });

  // 埋点：写一行 companion_nudge_events（best-effort，DB 失败不影响主流程）
  try {
    await ensureSchema();
    await execWithFailover((sql) =>
      sql`INSERT INTO companion_nudge_events (user_key, source, stage, hit_red_line)
          VALUES (${identity.key}, ${out.source}, ${profile.stage}, ${out.hitRedLine})`
    );
  } catch (error) {
    console.error('[companion/nudge] tracking write failed:', error instanceof Error ? error.message : error);
  }

  const body: CompanionNudgeResponse = {
    text: out.text,
    source: out.source,
    hitRedLine: out.hitRedLine,
  };
  const responseHeaders: Record<string, string> = {};
  if (identity.newGuestCookie) responseHeaders['Set-Cookie'] = identity.newGuestCookie;
  return NextResponse.json(body, Object.keys(responseHeaders).length > 0 ? { headers: responseHeaders } : undefined);
}