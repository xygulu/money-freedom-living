// POST /api/touch/dispatch：触达调度的引擎（M11-E，docs/05 §9.5 第 1 项）。
//
// 为什么调度逻辑在路由里、脚本只是个薄壳：模板是四语 dict、选人是 TS 纯函数，
// 放在 .mjs 脚本里要么重写一遍要么引一套构建。systemd timer 打这个端点最省事，
// 换成别的调度器（cron / 云函数 / 手动 curl）也不用改一行业务。
//
// 四道闸，顺序不能乱：
// 1. `TOUCH_CRON_SECRET` —— 没配 secret 直接 503（绝不开一个谁都能打的发信端点）
// 2. `touchConfigured()` —— Resend 没配就**优雅降级**成 dry-run，不报错、不假装发了
// 3. `pickTouchNode` —— opt-in / 活跃度 / 最小间隔 / 节点是否发过
// 4. `claimTouchNode` —— **先占位再发**（单条 UPDATE 原子判断）。宁可漏发不可重发：
//    占位成功但发信失败的那封，这一辈子就不发了 —— 重发一封三个月前的信比漏发更糟。
//
// 返回的统计里没有任何 PII：只有数量、节点名与跳过原因的计数。
import { NextRequest, NextResponse } from 'next/server';
import { listTouchCandidates, claimTouchNode } from '@/lib/profile';
import { pickTouchNode, composeTouch, touchConfigured, isDeliverableEmail } from '@/lib/touch';
import { sendResendEmail } from '@/lib/email-resend';
import { getDict } from '@/i18n/get-dict';
import { defaultLocale, enabledLocales, isLocale } from '@/i18n/config';
import { track } from '@/lib/analytics';
import { getSql } from '@/lib/db';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

async function emailOf(userKey: string): Promise<string | null> {
  const id = userKey.startsWith('u:') ? userKey.slice(2) : null;
  if (!id) return null; // 游客没有邮箱——发不了，也不该发
  const rows = await getSql()`SELECT email FROM "user" WHERE id = ${id} LIMIT 1`;
  const email = rows[0]?.email;
  return typeof email === 'string' && email.includes('@') ? email : null;
}

export async function POST(request: NextRequest) {
  const secret = process.env.TOUCH_CRON_SECRET;
  if (!secret) return jsonError('touch_cron_not_configured', 503);
  if (request.headers.get('x-touch-secret') !== secret) return jsonError('forbidden', 403);

  try {
    const body = (await request.json().catch(() => ({}))) as { dryRun?: boolean; limit?: number };
    // 通道没配好 = 这台机器不发信：照常算一遍该发谁（好验证），但一封都不发、也不占位
    const configured = touchConfigured();
    const dryRun = body.dryRun === true || !configured;
    const limit = Math.min(Math.max(body.limit ?? 500, 1), 2000);
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? new URL(request.url).origin;

    const candidates = await listTouchCandidates(limit);
    const now = new Date();
    const skipped: Record<string, number> = {};
    const byNode: Record<string, number> = {};
    const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
    let sent = 0;
    let planned = 0;
    let failed = 0;

    for (const profile of candidates) {
      const node = pickTouchNode(profile, now);
      if (!node) { skip('not_due'); continue; }
      // byNode 记的是**选人的结果**（谁到了哪个节点），planned 记的是**真会寄出几封**。
      // 分开是有意的：收件人不可达时前者照旧、后者不加，一眼能看出"选人对不对"和
      // "寄得出去几封"是两件事分别出了问题还是同一件。
      byNode[node] = (byNode[node] ?? 0) + 1;

      const email = await emailOf(profile.user_key);
      if (!email) { skip('no_email'); continue; }
      // smoke 建的 @smoke.test 之类：寄出去必定硬退，退多了整个发信域名被降权
      if (!isDeliverableEmail(email)) { skip('test_address'); continue; }

      const locale = isLocale(profile.locale) && enabledLocales.includes(profile.locale) ? profile.locale : defaultLocale;
      const letter = composeTouch({ node, profile, dict: getDict(locale), locale, baseUrl });
      if (!letter) { skip('no_template'); continue; }

      planned++;
      if (dryRun) continue;

      // 先占位：抢不到说明别的进程/上一次跑已经发过这个节点了
      if (!(await claimTouchNode(profile.user_key, node))) { skip('already_sent'); continue; }
      try {
        await sendResendEmail({ to: email, subject: letter.subject, text: letter.text, html: letter.html });
        sent++;
        await track(profile.user_key, 'touch_sent', { node }, locale);
      } catch (error) {
        // 占位不回滚：重发一封三个月前的信，比漏发一封更伤
        failed++;
        console.error('[touch/dispatch] send failed', node, error instanceof Error ? error.message : error);
      }
    }

    return NextResponse.json(
      { ok: true, configured, dryRun, scanned: candidates.length, planned, sent, failed, byNode, skipped },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[touch/dispatch]', error instanceof Error ? error.message : error);
    return jsonError('touch_dispatch_failed', 500);
  }
}
