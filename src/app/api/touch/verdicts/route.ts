// POST /api/touch/verdicts：6 节点答卷的读取端（docs/10 P0-2 §2.2）。
//
// 为什么读数也要走端点、不直接在脚本里读库：读取端（`src/lib/verdicts.ts`）是 TS，
// `scripts/*.mjs` 是纯 Node，引不了 —— 跟 `/api/touch/dispatch` 同一个理由，
// 业务逻辑留在这里，脚本只负责"去敲一下"。见 `scripts/verify-nodes.mjs`。
//
// 鉴权跟 dispatch / preview 同一把钥匙、同一个范式（`TOUCH_CRON_SECRET` + `x-touch-secret`）：
// 这是全站唯一一处能按人读出「谁在哪一步没走通」的接口，多造一套密钥就多一处会漏的地方。
//
// 返回里**没有原话**：`basisTopic`/`basisAt` 是指针，拿它回 `threads[].evidence` 才能取到
// 他说的那一句。读数接口不该顺手把用户的句子搬进 journal。
import { NextRequest, NextResponse } from 'next/server';
import { listNodeVerdicts, summarizeNodeVerdicts } from '@/lib/verdicts';
import { VERDICT_NODES } from '@/lib/cognition';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const secret = process.env.TOUCH_CRON_SECRET;
  if (!secret) return jsonError('touch_cron_not_configured', 503);
  if (request.headers.get('x-touch-secret') !== secret) return jsonError('forbidden', 403);

  try {
    const body = (await request.json().catch(() => ({}))) as { userKey?: string; limit?: number };
    const limit = Math.min(Math.max(body.limit ?? 5000, 1), 20000);
    const userKey = typeof body.userKey === 'string' && body.userKey ? body.userKey : undefined;

    const rows = await listNodeVerdicts({ userKey, limit });
    // 全体口径的 summary 跟单人口径是**两个问题**：全体问"这条路对人群成不成立"，
    // 单人问"这个人走到哪了"。合在一起算会把一个人的三态读成整轮的结论。
    const summary = userKey ? summarizeNodeVerdicts(rows) : null;

    return NextResponse.json(
      {
        ok: true,
        count: rows.length,
        // 节点清单也一起回：脚本要按固定顺序打表（D7→D90），自己抄一份就会漂。
        // 空表也要按这份顺序摆出来 —— "这个节点一条答卷都没有"本身就是读数。
        nodes: VERDICT_NODES,
        rows,
        summary,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[touch/verdicts]', error instanceof Error ? error.message : error);
    return jsonError('touch_verdicts_failed', 500);
  }
}
