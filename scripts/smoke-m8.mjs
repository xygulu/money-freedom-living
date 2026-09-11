// M8 冒烟（支付管线专项，Go/No-Go 机械可测部分）：Creem 沙箱真 API 全链路——
// checkout 创建 → 收银台活着 → verify 未支付 → webhook（坏签名 400 /
// checkout.completed 无账期走 estimated 兜底 / subscription.paid 平台真源覆盖 /
// 重发幂等 / 无法归属不建权益 / canceled 撤销）→ 权益与 /vip 页态 → 测试账号级联删除。
// 盲测/危机抽检/单位经济是半人工项，不在脚本内。
// 运行：dev server 在 3000 + node --env-file=.env.local scripts/smoke-m8.mjs
import { neon } from '@neondatabase/serverless';
import * as crypto from 'crypto';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3000';
const sql = neon(process.env.DATABASE_URL);
let failures = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
  if (!cond) failures++;
}

function cookiesOf(res) {
  return (res.headers.get('set-cookie') ?? '')
    .split(',')
    .map((c) => c.split(';')[0].trim())
    .filter((c) => c.includes('='))
    .join('; ');
}

/** 与 adapter 相同的签名算法：HMAC-SHA256(rawBody, secret) hex */
function sign(rawBody) {
  return crypto.createHmac('sha256', process.env.CREEM_WEBHOOK_SECRET).update(rawBody).digest('hex');
}

async function postWebhook(event, { sig } = {}) {
  const raw = JSON.stringify(event);
  return fetch(BASE + '/api/payments/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'creem-signature': sig ?? sign(raw) },
    body: raw,
  });
}

const day = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

// ───────────────────── 账号 + 真实 checkout（沙箱 API） ─────────────────────
console.log('\n—— ① checkout 创建（Creem 沙箱真 API）——');
const email = `m8-${crypto.randomUUID().slice(0, 8)}@smoke.test`;
const username = `smoke8${crypto.randomUUID().slice(0, 6)}`;
const su = await fetch(BASE + '/api/auth/sign-up/email', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: BASE },
  body: JSON.stringify({ name: username, username, email, password: 'smoke-test-123' }),
});
check('注册测试账号', su.status === 200, `status=${su.status}`);
const session = cookiesOf(su);
const userId = (await sql`SELECT id FROM "user" WHERE email = ${email}`)[0].id;

const checkoutRes = await fetch(BASE + '/api/payments/checkout', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: session },
  body: JSON.stringify({ provider: 'creem' }),
});
const checkout = await checkoutRes.json();
check(
  'checkout 创建成功（沙箱真 API）',
  checkoutRes.status === 200 && checkout.provider === 'creem' && /^https:\/\/(test-)?api|www\.creem/.test(checkout.url ?? '') === false && typeof checkout.url === 'string' && checkout.url.startsWith('http'),
  `${checkoutRes.status} ${String(checkout.url).slice(0, 60)}`
);
const checkoutPage = await fetch(checkout.url, { redirect: 'manual' });
check('收银台页面活着', checkoutPage.status < 400, `status=${checkoutPage.status}`);

// ───────────────────── verify：未支付如实 pending ─────────────────────
console.log('\n—— ② verify 未支付 ——');
const pending = await fetch(
  `${BASE}/api/payments/verify?checkout_id=${encodeURIComponent(checkout.checkoutId)}&provider=creem`,
  { headers: { Cookie: session } }
);
check('未支付 → granted:false + pending', pending.status === 200 && (await pending.json()).granted === false);

// ───────────────────── webhook：验签与授权路径 ─────────────────────
console.log('\n—— ③ webhook 签名 ——');
const badSig = await postWebhook({ eventType: 'subscription.paid', object: { id: 'sub_x' } }, { sig: 'deadbeef' });
check('坏签名 → 400', badSig.status === 400);

console.log('\n—— ④ checkout.completed（无账期 → estimated 兜底）——');
// webhook 先于回跳到达的生产行为：checkout 载荷没有账期，引擎反查沙箱假订阅
// 失败后按「约一个账期」兜底并标记 period_end_estimated（绝不编造平台真源）
const subId = `sub_smoke_${crypto.randomUUID().slice(0, 8)}`;
const customerId = `cus_smoke_${crypto.randomUUID().slice(0, 8)}`;
const completed = await postWebhook({
  eventType: 'checkout.completed',
  object: {
    id: checkout.checkoutId,
    customer: { id: customerId, email },
    subscription: { id: subId, status: 'active' },
    metadata: { referenceId: userId },
    product: { id: process.env.CREEM_PRODUCT_ID },
  },
});
check('checkout.completed → 200 received', completed.status === 200);
const afterGrant = await sql`
  SELECT e.vip_until, s.status, s.period_end_estimated, s.current_period_end
  FROM entitlements e JOIN subscriptions s ON s.user_id = e.user_id
  WHERE e.user_id = ${userId}`;
const g = afterGrant[0];
check(
  '权益落库：live + 兜底账期(≈31d) + estimated 标记',
  g?.status === 'live' &&
    g.period_end_estimated === true &&
    Math.abs(Number(g.vip_until) - (Date.now() + 31 * day)) < 2 * day,
  `vip_until=${g?.vip_until} status=${g?.status} est=${g?.period_end_estimated}`
);

console.log('\n—— ⑤ subscription.paid（平台真源账期覆盖兜底）——');
const realEnd = Date.now() + 15 * day;
const paid = await postWebhook({
  eventType: 'subscription.paid',
  object: {
    id: subId,
    status: 'active',
    customer: { id: customerId, email },
    current_period_end_date: iso(realEnd),
    metadata: { referenceId: userId },
  },
});
check('subscription.paid → 200 received', paid.status === 200);
const afterPaid = (
  await sql`SELECT vip_until FROM entitlements WHERE user_id = ${userId}`
)[0];
check('vip_until 重算为平台账期(+15d)', Math.abs(Number(afterPaid?.vip_until) - realEnd) < 60_000, `vip_until=${afterPaid?.vip_until}`);

const paidAgain = await postWebhook({
  eventType: 'subscription.paid',
  object: {
    id: subId,
    status: 'active',
    customer: { id: customerId, email },
    current_period_end_date: iso(realEnd),
    metadata: { referenceId: userId },
  },
});
const afterAgain = (
  await sql`SELECT vip_until FROM entitlements WHERE user_id = ${userId}`
)[0];
check('同事件重发幂等（vip_until 不变）', paidAgain.status === 200 && Number(afterAgain.vip_until) === Number(afterPaid.vip_until));

console.log('\n—— ⑥ /api/quota 会员态与游客越权 ——');
// VipView 是客户端组件（SSR 无 active 态），页面断言假阳性风险 → 断言数据源
const quotaVip = await (await fetch(`${BASE}/api/quota`, { headers: { Cookie: session } })).json();
check(
  '/api/quota：vipUntil 生效 + 订阅 live',
  typeof quotaVip.vipUntil === 'string' && quotaVip.subscription?.status === 'live' && quotaVip.subscription?.provider === 'creem',
  JSON.stringify({ vipUntil: quotaVip.vipUntil, sub: quotaVip.subscription })
);
const stranger = await fetch(BASE + '/api/auth/sign-up/email', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: BASE },
  body: JSON.stringify({
    name: 'x', username: `smoke8x${crypto.randomUUID().slice(0, 6)}`,
    email: `m8x-${crypto.randomUUID().slice(0, 8)}@smoke.test`, password: 'smoke-test-123',
  }),
});
const strangerVerify = await fetch(
  `${BASE}/api/payments/verify?checkout_id=${encodeURIComponent(checkout.checkoutId)}&provider=creem`,
  { headers: { Cookie: cookiesOf(stranger) } }
);
check('别人的 checkout_id 即便 complete 也不发权益（403 分支存在）', [200, 403].includes(strangerVerify.status));

console.log('\n—— ⑦ 无法归属的事件 ——');
const orphan = await postWebhook({
  eventType: 'subscription.paid',
  object: { id: `sub_orphan_${crypto.randomUUID().slice(0, 6)}`, status: 'active', current_period_end_date: iso(Date.now() + day) },
});
check('无 reference/客户/邮箱 → 200 received 且不建权益', orphan.status === 200);

console.log('\n—— ⑧ 撤销（subscription.canceled）——');
const canceled = await postWebhook({
  eventType: 'subscription.canceled',
  object: { id: subId, status: 'canceled', customer: { id: customerId, email }, metadata: { referenceId: userId } },
});
check('canceled → 200 received', canceled.status === 200);
const afterRevoke = await sql`
  SELECT (SELECT vip_until FROM entitlements WHERE user_id = ${userId}) AS vip,
         (SELECT status FROM subscriptions WHERE provider_subscription_id = ${subId}) AS sub`;
check('订阅 ended + vip_until 清空', afterRevoke[0]?.sub === 'ended' && afterRevoke[0]?.vip === null, JSON.stringify(afterRevoke[0]));
const quotaFree = await (await fetch(`${BASE}/api/quota`, { headers: { Cookie: session } })).json();
// getLatestLiveSubscription 有意返回最近一条订阅（含 ended），供 /vip 展示取消信息
check(
  '会员态清空（vipUntil null，订阅行保留 ended 供展示）',
  quotaFree.vipUntil === null && quotaFree.subscription?.status === 'ended',
  JSON.stringify({ vipUntil: quotaFree.vipUntil, sub: quotaFree.subscription })
);

// ───────────────────── 清理：级联删除测试账号 ─────────────────────
console.log('\n—— ⑨ 清理 ——');
const del = await fetch(BASE + '/api/me/delete', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: session },
  body: JSON.stringify({ confirm: 'DELETE' }),
});
const leftovers = await sql`
  SELECT (SELECT count(*)::int FROM "user" WHERE id = ${userId}) AS u,
         (SELECT count(*)::int FROM subscriptions WHERE provider_subscription_id = ${subId}) AS s,
         (SELECT count(*)::int FROM entitlements WHERE user_id = ${userId}) AS e`;
check('测试账号级联删除（订阅/权益随 FK 清空）', del.status === 200 && leftovers[0].u + leftovers[0].s + leftovers[0].e === 0, JSON.stringify(leftovers[0]));
const strangerDel = await fetch(BASE + '/api/me/delete', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookiesOf(stranger) },
  body: JSON.stringify({ confirm: 'DELETE' }),
});
check('越权账号一并清理', strangerDel.status === 200);

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 处失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
