// 触达调度的薄壳（M11-E，docs/05 §9.5 第 1 项）。
//
// 真正的逻辑在 /api/touch/dispatch —— 模板是四语 dict、选人是 TS 纯函数，脚本这边
// 只负责"到点了，去敲一下那个端点"。换掉 systemd 换成别的调度器也不用改业务。
//
// 默认 **dry-run**：算一遍该发谁、发什么节点，一封都不发。真发要显式 --send。
// Resend 没配时服务端会自动降级成 dry-run，这里照样跑得通（不报错、不假装发了）。
//
// 用法：
//   node --env-file=.env.local scripts/touch-dispatch.mjs            # 试算
//   node --env-file=.env.local scripts/touch-dispatch.mjs --send     # 真发
//   node --env-file=.env.local scripts/touch-dispatch.mjs --send --limit 50
const BASE = process.env.TOUCH_BASE_URL ?? process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000';
const secret = process.env.TOUCH_CRON_SECRET;

const args = process.argv.slice(2);
const send = args.includes('--send');
const limitArg = args.indexOf('--limit');
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : undefined;

if (!secret) {
  // 没配 secret 不是故障，是"这台机器不跑触达"：timer 空转一次就走，不刷红
  console.log('[touch] TOUCH_CRON_SECRET 未配置 —— 跳过（这台机器不发信）');
  process.exit(0);
}

const res = await fetch(`${BASE}/api/touch/dispatch`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-touch-secret': secret },
  body: JSON.stringify({ dryRun: !send, ...(limit ? { limit } : {}) }),
});

const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`[touch] HTTP ${res.status}`, body.error ?? '');
  process.exit(1);
}

// 输出里没有邮箱、没有 user_key、没有信的内容 —— 只有数量与节点名
const { configured, dryRun, scanned, planned, sent, failed, byNode, skipped } = body;
console.log(
  `[touch] ${dryRun ? '试算' : '已发送'}${configured ? '' : '（Resend 未配置 → 自动降级为试算）'}：` +
    `扫 ${scanned} 人，命中 ${planned}，发出 ${sent}，失败 ${failed}`
);
if (Object.keys(byNode ?? {}).length) console.log('[touch] 按节点：', JSON.stringify(byNode));
if (Object.keys(skipped ?? {}).length) console.log('[touch] 跳过原因：', JSON.stringify(skipped));
process.exit(failed > 0 ? 1 : 0);
