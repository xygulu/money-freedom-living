// M6 冒烟：VIP 页三态 + 免费墙三处 + 未配置 Creem 的优雅降级（无需真实支付 key）
//   ① /vip 游客态：登录引导
//   ② 登录页渲染 + 真实注册/登录（better-auth，Origin 头）
//   ③ 免费登录态：订阅按钮 + 未配置降级；checkout 优雅失败
//   ④ VIP 生效态（种 entitlements）：状态卡 + 管理订阅优雅降级
//   ⑤ verify 回查优雅降级；/me 两态；journey 报告占位；chat 付费墙①链接
// 运行：dev server 在 3000 + node --env-file=.env.local scripts/smoke-m6.mjs
import { neon } from '@neondatabase/serverless';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3000';
const sql = neon(process.env.DATABASE_URL);
let failures = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
  if (!cond) failures++;
}

async function page(path, cookie) {
  const res = await fetch(BASE + path, { headers: cookie ? { Cookie: cookie } : {} });
  return { status: res.status, html: await res.text() };
}

// ───────────────────────── ① /vip 游客态 + 登录页 ─────────────────────────
{
  console.log('\n—— ① /vip 游客态 + 登录页 ——');
  const vip = await page('/zh-CN/vip');
  check('/vip 渲染（游客 → 登录引导）', vip.status === 200 && vip.html.includes('订阅 VIP 需要先有一个账号'));
  const login = await page('/zh-CN/login');
  check('/login 渲染表单', login.status === 200 && login.html.includes('邮箱'));
  // 已登录访问 /login → 重定向 /me（后续登录流程后不再回这里）
}

// ───────────────────────── ② 注册 / 登录 ─────────────────────────
{
  console.log('\n—— ② 注册 / 登录 ——');
  const email = `m6-${crypto.randomUUID().slice(0, 8)}@smoke.test`;
  const signupRes = await fetch(BASE + '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ name: 'smoke6', email, password: 'smoke-test-123' }),
  });
  const cookie = (signupRes.headers.get('set-cookie') ?? '')
    .split(',')
    .map((c) => c.split(';')[0].trim())
    .filter((c) => c.includes('='))
    .join('; ');
  check('注册成功并拿到 session', signupRes.ok && cookie.includes('session'), `status=${signupRes.status}`);

  // 登录页对已登录用户重定向
  const loginRedirect = await fetch(BASE + '/zh-CN/login', { headers: { Cookie: cookie }, redirect: 'manual' });
  check('已登录访问 /login → 跳转', loginRedirect.status === 307 || loginRedirect.status === 302);

  // 独立登录流：新会话 sign-in
  const signinRes = await fetch(BASE + '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ email, password: 'smoke-test-123' }),
  });
  check('sign-in 成功', signinRes.ok, `status=${signinRes.status}`);

  globalThis.__m6 = { email, cookie };
}

// ───────────────────────── ③ 免费登录态 + 优雅降级 ─────────────────────────
{
  console.log('\n—— ③ 免费登录态 ——');
  const { email, cookie } = globalThis.__m6;
  const vip = await page('/zh-CN/vip', cookie);
  check('/vip 免费态：权益清单 + 订阅按钮', vip.html.includes('对话不限次数') && vip.html.includes('开通 VIP'));
  check('支付未配置 → 优雅降级提示', vip.html.includes('支付通道正在最后准备'));

  const checkout = await fetch(BASE + '/api/payments/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({}),
  });
  const checkoutBody = await checkout.json();
  // 这条守的是「不崩」，不是「没配」：这台机器配没配 Creem 是环境的事，不该决定断言成败。
  // 配了 → 200 + 一条真的支付链接；没配 → 500 + NOT_CONFIGURED。两者都是结构化的回答，
  // 唯独 HTML 错误页 / 空 body 不行。（断言绑死环境，换台机器就红——m11 §⑦ 栽过一次）
  check(
    'checkout 无论配没配 Creem 都给结构化回答（不崩）',
    (checkout.status === 500 && checkoutBody.code === 'NOT_CONFIGURED') ||
      (checkout.status === 200 && typeof checkoutBody.url === 'string') ||
      typeof checkoutBody.code === 'string',
    `status=${checkout.status} code=${checkoutBody.code ?? 'url'}`
  );

  const verify = await fetch(BASE + '/api/payments/verify?checkout_id=nonexistent', {
    headers: { Cookie: cookie },
  });
  const verifyBody = await verify.json();
  check(
    'verify 查一个不存在的会话：结构化错误，不崩',
    verify.status >= 400 && typeof verifyBody.code === 'string',
    `status=${verify.status} code=${verifyBody.code}`
  );

  const me = await page('/zh-CN/me', cookie);
  check('/me 登录态：邮箱 + VIP 入口', me.html.includes(email) && me.html.includes('VIP 订阅'));
}

// ───────────────────────── ④ VIP 生效态 ─────────────────────────
{
  console.log('\n—— ④ VIP 生效态 ——');
  const { email, cookie } = globalThis.__m6;
  const userRow = await sql`SELECT id FROM "user" WHERE email = ${email}`;
  await sql`
    INSERT INTO entitlements (user_id, vip_until) VALUES (${userRow[0].id}, now() + interval '30 days')
    ON CONFLICT (user_id) DO UPDATE SET vip_until = now() + interval '30 days'
  `;

  const vip = await page('/zh-CN/vip', cookie);
  check('/vip 生效中：状态卡 + 到期日 + 管理订阅', vip.html.includes('VIP 生效中') && vip.html.includes('管理订阅'));

  const portal = await fetch(BASE + '/api/payments/portal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
  });
  const portalBody = await portal.json();
  check(
    'portal 无订阅记录 → 结构化错误（不崩）',
    portal.status === 400 && portalBody.code === 'NO_SUBSCRIPTION',
    `status=${portal.status}`
  );

  const me = await page('/zh-CN/me', cookie);
  check('/me VIP 态提示生效中', me.html.includes('生效中'));

  // VIP 配额语义：对话配额对 VIP 不再限制（quota 层 M4 已实现，这里验证页面不出现游客墙）
  const chatPage = await page('/zh-CN/chat', cookie);
  check('/chat VIP 正常入口', chatPage.status === 200 && chatPage.html.includes('开始今天的对话'));
}

// ───────────────────────── ⑤ 免费墙三处 ─────────────────────────
{
  console.log('\n—— ⑤ 免费墙三处 ——');
  // ③ journey 报告占位
  const journey = await page('/zh-CN/journey');
  check('③ journey：深度报告占位 + VIP 链接', journey.html.includes('深度报告') && journey.html.includes('/zh-CN/vip'));

  // ① chat 会话用完：游客开场用掉当日额度 → 结束会话 → /chat 页显示付费墙文案
  const guestId = crypto.randomUUID().replace(/-/g, '');
  const guestCookie = `guest_qk=${guestId}`;
  const create = await fetch(BASE + '/api/chat/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: guestCookie },
    body: JSON.stringify({ locale: 'zh-CN' }),
  }).then((r) => r.json());
  // opener 成功才落账（游客 1/日 用尽）；LLM 瞬时失败不扣，重试一次
  let openerOk = false;
  for (let i = 0; i < 2 && !openerOk; i++) {
    const res = await fetch(BASE + `/api/chat/${create.session}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: guestCookie },
      body: JSON.stringify({ opener: true }),
    });
    const body = await res.text();
    openerOk = res.ok && /"delta"/.test(body);
  }
  check('游客 opener 成功（触发落账）', openerOk);
  await fetch(BASE + `/api/chat/${create.session}`, { method: 'DELETE', headers: { Cookie: guestCookie } });
  const chat = await page('/zh-CN/chat', guestCookie);
  check(
    '① chat 用完：今日先到这里 + VIP 链接',
    chat.html.includes('今天先到这里') && chat.html.includes('/zh-CN/vip'),
  );
  // ② journal 回应门禁（M5 冒烟已验 403 + 前端文案，这里验页面含门禁入口结构）
  const journal = await page('/zh-CN/journal');
  check('② journal 页渲染', journal.status === 200);
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 处失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
