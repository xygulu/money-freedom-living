// POST /api/touch/dispatch：触达调度的引擎（M11-E，docs/05 §9.5 第 1 项）。
//
// 为什么调度逻辑在路由里、脚本只是个薄壳：模板是四语 dict、选人是 TS 纯函数，
// 放在 .mjs 脚本里要么重写一遍要么引一套构建。systemd timer 打这个端点最省事，
// 换成别的调度器（cron / 云函数 / 手动 curl）也不用改一行业务。
//
// 四道闸，顺序不能乱：
// 1. `TOUCH_CRON_SECRET` —— 没配 secret 直接 503（绝不开一个谁都能打的发信端点）
// 2. 通道配置 —— Resend 和 APNs 都没配就**优雅降级**成 dry-run，不报错、不假装发了
// 3. `pickTouchNode` —— opt-in / 活跃度 / 最小间隔 / 节点是否发过
// 4. `claimTouchNode` —— **先占位再发**（单条 UPDATE 原子判断）。宁可漏发不可重发：
//    发送抛错时只有"确定没发出去"的那类（Resend 401/403/422、APNs 401/403）才把占位
//    还回去并中止整轮，超时/5xx 这类送没送到不好说的一律留着占位——重发一封三个月前
//    的信比漏发更糟。
//
// 通道选择（docs/11 M2）：有设备 token 且 APNs 配好 → push；否则 → email。
// 两条通道共享全部节点状态（sentNodes/lastSentAt/MIN_GAP），同一节点绝不双轰——
// token 在，信就不发；token 不在（卸载/没装壳），回落信。游客（g:）只有推送一条道。
//
// 返回的统计里没有任何 PII：只有数量、节点名与跳过原因的计数。
import { NextRequest, NextResponse } from 'next/server';
import { listTouchCandidates, claimTouchNode, releaseTouchNode, removePushToken } from '@/lib/profile';
import {
  pickTouchNode,
  composeTouch,
  composePush,
  touchConfigured,
  pushConfigured,
  isDeliverableEmail,
  type TouchChannel,
} from '@/lib/touch';
import { sendResendEmail } from '@/lib/email-resend';
import { sendApns, apnsPayload, ApnsChannelError, ApnsUnregisteredError } from '@/lib/push-apns';
import { getDict } from '@/i18n/get-dict';
import { defaultLocale, enabledLocales, isLocale } from '@/i18n/config';
import { track } from '@/lib/analytics';
import { getSql } from '@/lib/db';
import { jsonError } from '@/lib/sse';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * 这个错误是不是"通道本身坏了"。
 *
 * 分两类是为了分两种处置：401/403（key 废了）、422（from 地址不合法）这类，Resend 在
 * 收下信之前就回绝了 —— 信**确定**一个字没出去，占位可以安心撤回；而且下一个人一定
 * 一模一样地失败，整轮该立刻停，不是把几百个节点一个个烧成"发过了"。
 * 反过来，超时、5xx 这类是**不知道有没有送出去**：撤回就有重发的风险，宁可漏。
 */
function isChannelError(error: unknown): boolean {
  if (error instanceof ApnsChannelError) return true;
  const msg = error instanceof Error ? error.message : String(error);
  return /^Resend HTTP (401|403|422)\b/.test(msg);
}

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
    // 两条通道各自看配置；全都没配 = 这台机器不触达：照常算一遍该发谁（好验证），一封不发、不占位
    const emailReady = touchConfigured();
    const pushReady = pushConfigured();
    const dryRun = body.dryRun === true || (!emailReady && !pushReady);
    const limit = Math.min(Math.max(body.limit ?? 500, 1), 2000);
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? new URL(request.url).origin;

    const candidates = await listTouchCandidates(limit);
    const now = new Date();
    const skipped: Record<string, number> = {};
    const byNode: Record<string, number> = {};
    const byChannel: Record<TouchChannel, number> = { email: 0, push: 0 };
    const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
    let sent = 0;
    let planned = 0;
    let failed = 0;
    let aborted: string | null = null;

    for (const profile of candidates) {
      // 通道选择在 pickTouchNode 之前：token 在且 APNs 配好 → push（guest 只有这条路）
      const tokens = profile.push_tokens ?? [];
      const channel: TouchChannel = pushReady && tokens.length > 0 ? 'push' : 'email';
      const node = pickTouchNode(profile, now, channel);
      if (!node) { skip('not_due'); continue; }
      // byNode 记的是**选人的结果**（谁到了哪个节点），planned 记的是**真会寄出几封**。
      // 分开是有意的：收件人不可达时前者照旧、后者不加，一眼能看出"选人对不对"和
      // "寄得出去几封"是两件事分别出了问题还是同一件。
      byNode[node] = (byNode[node] ?? 0) + 1;

      const locale = isLocale(profile.locale) && enabledLocales.includes(profile.locale) ? profile.locale : defaultLocale;

      if (channel === 'push') {
        const push = composePush({ node, profile, dict: getDict(locale), locale, baseUrl });
        if (!push) { skip('no_template'); continue; }
        planned++;
        if (dryRun) continue;
        // 先占位：抢不到说明别的进程/上一次跑已经触达过这个节点了
        if (!(await claimTouchNode(profile.user_key, node))) { skip('already_sent'); continue; }
        try {
          const deadTokens: string[] = [];
          let delivered = 0;
          for (const entry of tokens) {
            try {
              await sendApns(entry.token, apnsPayload({ title: push.title, body: push.body }, push.url));
              delivered++;
            } catch (error) {
              if (error instanceof ApnsUnregisteredError) {
                // 卸载/系统撤销：token 已死，摘掉别再试（单台设备的事，不影响这一轮）
                deadTokens.push(entry.token);
                continue;
              }
              // ChannelError（key 废了）让外层停整轮；其余（超时/5xx）送没送到不好说，
              // 占位不回滚。两类都是同一个去处：抛给外层分流。
              throw error;
            }
          }
          for (const dead of deadTokens) await removePushToken(profile.user_key, dead);
          if (delivered > 0) {
            // 人次统计按"人"不按"设备"：三台设备同收一封，触达还是发生了一次
            sent++;
            byChannel.push++;
            await track(profile.user_key, 'touch_sent', { node, channel }, locale);
          } else {
            failed++;
            await track(profile.user_key, 'touch_send_failed', { node, channel }, locale);
          }
        } catch (error) {
          failed++;
          console.error('[touch/dispatch] push failed', node, error instanceof Error ? error.message : error);
          await track(profile.user_key, 'touch_send_failed', { node, channel }, locale);
          if (isChannelError(error)) {
            await releaseTouchNode(profile.user_key, node);
            aborted = 'channel_error';
            break;
          }
        }
        continue;
      }

      // ---- email 通道（M11-E 原路径，零语义改动）----
      const email = await emailOf(profile.user_key);
      if (!email) { skip('no_email'); continue; }
      // smoke 建的 @smoke.test 之类：寄出去必定硬退，退多了整个发信域名被降权
      if (!isDeliverableEmail(email)) { skip('test_address'); continue; }

      const letter = composeTouch({ node, profile, dict: getDict(locale), locale, baseUrl });
      if (!letter) { skip('no_template'); continue; }

      planned++;
      if (dryRun) continue;

      // 先占位：抢不到说明别的进程/上一次跑已经发过这个节点了
      if (!(await claimTouchNode(profile.user_key, node))) { skip('already_sent'); continue; }
      try {
        await sendResendEmail({
          to: email,
          subject: letter.subject,
          text: letter.text,
          html: letter.html,
          // RFC 8058：收件方（Gmail/Yahoo 2024 起要求批量发信必须有）据此在信头上直接给一个
          // 退订按钮。One-Click 意味着他们会替用户 POST 过来，不需要用户点进页面确认——
          // 所以退订路由的 POST 分支必须能裸着被打（见 api/touch/unsubscribe）。
          headers: {
            'List-Unsubscribe': `<${letter.unsub}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        });
        sent++;
        byChannel.email++;
        await track(profile.user_key, 'touch_sent', { node, channel }, locale);
      } catch (error) {
        failed++;
        console.error('[touch/dispatch] send failed', node, error instanceof Error ? error.message : error);
        await track(profile.user_key, 'touch_send_failed', { node, channel }, locale);
        if (isChannelError(error)) {
          // 信确定没出去：把占位还回去，这个人下一轮还能收到这封
          await releaseTouchNode(profile.user_key, node);
          aborted = 'channel_error';
          break;
        }
        // 送没送到不好说：占位不回滚。重发一封三个月前的信，比漏发一封更伤
      }
    }

    return NextResponse.json(
      { ok: true, configured: emailReady || pushReady, dryRun, scanned: candidates.length, planned, sent, failed, aborted, byNode, byChannel, skipped },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[touch/dispatch]', error instanceof Error ? error.message : error);
    return jsonError('touch_dispatch_failed', 500);
  }
}
