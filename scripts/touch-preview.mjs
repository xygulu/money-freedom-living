// 触达信预览/试寄的薄壳（M11-E）。
//
// 干什么用：把一封样信寄到**你自己**的邮箱，看排版、看「回到这里」和退订链接在真实
// 邮件客户端里成不成立。用的是合成档案，一行真实用户数据都不碰（见 /api/touch/preview）。
//
// 用法：
//   node --env-file=.env.local scripts/touch-preview.mjs                       # 只打印，不发
//   node --env-file=.env.local scripts/touch-preview.mjs --node D3 --locale en
//   node --env-file=.env.local scripts/touch-preview.mjs --send --to you@example.com
//
// --to 不给就寄给 SUPPORT_EMAIL。没有 --send 一封都不发。
const BASE = process.env.TOUCH_BASE_URL ?? process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000';
const secret = process.env.TOUCH_CRON_SECRET;

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const send = args.includes('--send');
const node = flag('node', 'D30');
const locale = flag('locale', 'zh-CN');
const to = flag('to', process.env.SUPPORT_EMAIL ?? '');
const echo = flag('echo', '我不敢报那个价。');

if (!secret) {
  console.error('[preview] TOUCH_CRON_SECRET 未配置 —— 端点不会开门');
  process.exit(1);
}
if (send && !to) {
  console.error('[preview] --send 需要收件人：--to you@example.com 或配好 SUPPORT_EMAIL');
  process.exit(1);
}

const res = await fetch(`${BASE}/api/touch/preview`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-touch-secret': secret },
  body: JSON.stringify({ node, locale, to, echo, send }),
});
const body = await res.json().catch(() => ({}));

if (!res.ok) {
  console.error(`[preview] HTTP ${res.status}`, body.error ?? '');
  process.exit(1);
}

if (body.sent) {
  // 收件人不打全：日志（journal）可能被别人看到
  const masked = to.replace(/^(.).*(@.*)$/, '$1***$2');
  console.log(`[preview] 已寄出 ${body.node} / ${body.locale} → ${masked}  resend-id=${body.id ?? '-'}`);
} else {
  const { subject, text } = body.letter;
  console.log(`[preview] ${body.node} / ${body.locale}（未寄出）`);
  console.log(`主题：${subject}`);
  console.log('---');
  console.log(text);
}
