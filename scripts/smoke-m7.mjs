// M7 冒烟：迁移 g:→u: / 单独同意 / 锚点与归来问候 / 恢复码 / 导出删除 / 隐私政策
// 运行：dev server 在 3000 + node --env-file=.env.local scripts/smoke-m7.mjs
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

function cookiesOf(res) {
  return (res.headers.get('set-cookie') ?? '')
    .split(',')
    .map((c) => c.split(';')[0].trim())
    .filter((c) => c.includes('='))
    .join('; ');
}

async function signUp() {
  const email = `m7-${crypto.randomUUID().slice(0, 8)}@smoke.test`;
  const username = `smoke7${crypto.randomUUID().slice(0, 6)}`;
  const res = await fetch(BASE + '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ name: username, username, email, password: 'smoke-test-123' }),
  });
  return { email, username, userId: res.ok ? (await sql`SELECT id FROM "user" WHERE email = ${email}`)[0].id : null, cookie: cookiesOf(res) };
}

// ───────────────────── ① 游客数据迁移 g:→u: ─────────────────────
{
  console.log('\n—— ① 游客数据迁移 g:→u: ——');
  const { email, userId, cookie: session } = await signUp();
  const guestId = crypto.randomUUID().replace(/-/g, '');
  const guest = `guest_qk=${guestId}`;

  // 游客期：写一篇日记 + 交一份问卷（无 consent，不生成画像）
  const entry = await fetch(BASE + '/api/journal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: guest },
    body: JSON.stringify({ content: '迁移前的一篇心事', locale: 'zh-CN' }),
  });
  check('游客写日记成功', entry.status === 200);
  await fetch(BASE + '/api/onboarding/answers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: guest },
    body: JSON.stringify({
      locale: 'zh-CN',
      answers: { moment_when: 'week', balance_feeling: 'panic', childhood: '妈妈把硬币数了三遍', payday_action: 'save', aspiration: 'relaxed', recent_worry: '还了卡债就没余钱了' },
    }),
  });

  // 登录态 + 游客 cookie 并存 → resolveIdentity 顺手迁移
  await fetch(BASE + '/api/journal', { headers: { Cookie: `${session}; ${guest}` } });

  const gKey = `g:${guestId}`;
  const uKey = `u:${userId}`;
  const rows = await sql`
    SELECT
      (SELECT count(*)::int FROM journal_entries WHERE user_key = ${uKey}) AS moved,
      (SELECT count(*)::int FROM journal_entries WHERE user_key = ${gKey}) AS left_g,
      (SELECT count(*)::int FROM growth_profiles WHERE user_key = ${uKey} AND portrait->'questionnaire' ? 'script_source') AS profile_moved,
      (SELECT count(*)::int FROM growth_profiles WHERE user_key = ${gKey}) AS profile_left_g
  `;
  const r = rows[0];
  check('日记迁到 u: 名下', r.moved >= 1, `moved=${r.moved}`);
  check('g: 名下日记清空', r.left_g === 0);
  check('档案（问卷）迁到 u: 名下', r.profile_moved === 1);
  check('g: 档案行已搬走', r.profile_left_g === 0);
  console.log(`  （迁移用户 ${email}）`);
  globalThis.__m7a = { email, userId, session };
}

// ───────────────────── ② 敏感信息单独同意（画像门禁） ─────────────────────
{
  console.log('\n—— ② 敏感信息单独同意 ——');
  const { email, userId, session } = globalThis.__m7a;
  const noConsent = await fetch(BASE + '/api/onboarding/portrait', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: session },
    body: JSON.stringify({ locale: 'zh-CN' }),
  });
  check('无 consent → 400 consent_required', noConsent.status === 400 && (await noConsent.json()).error === 'consent_required');

  const t0 = Date.now();
  const ok = await fetch(BASE + '/api/onboarding/portrait', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: session },
    body: JSON.stringify({ locale: 'zh-CN', consent: true }),
  });
  check('带 consent → 画像生成成功（LLM 真跑）', ok.status === 200, `status=${ok.status} ${(Date.now() - t0) / 1000}s`);
  const consent = await sql`
    SELECT granted, policy_version, ip_hash FROM consent_records WHERE user_key = ${`u:${userId}`} ORDER BY id DESC LIMIT 1
  `;
  check(
    '同意记录入库：granted + 政策版本 + IP 哈希（非原文 IP）',
    consent[0]?.granted === true && consent[0]?.policy_version === '2026-09-v1' && consent[0]?.ip_hash?.length === 64
  );
}

// ───────────────────── ③ 锚点：设置/非法/锚点日 ─────────────────────
{
  console.log('\n—— ③ 周期锚点 ——');
  const { session } = globalThis.__m7a;
  const bad = await fetch(BASE + '/api/journey/anchor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: session },
    body: JSON.stringify({ payday: { type: 'yearly', day: 1 } }),
  });
  check('非法锚点 → 400', bad.status === 400);

  const today = new Date().getUTCDate();
  const set = await fetch(BASE + '/api/journey/anchor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: session },
    body: JSON.stringify({ payday: { type: 'monthly', day: today } }),
  });
  check('设锚点成功', set.status === 200);

  const journey = await page('/zh-CN/journey', session);
  check('journey 页锚点卡出现', journey.html.includes('周期锚点'));
  check('今天恰是锚点日 → 锚点日文案出现', journey.html.includes('>今天是发薪日'));
  check('归来问候此时不出现（刚活跃过）', !journey.html.includes('>欢迎回来。它还在'));

  const clear = await fetch(BASE + '/api/journey/anchor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: session },
    body: JSON.stringify({ payday: null }),
  });
  check('清除锚点成功', clear.status === 200);
}

// ───────────────────── ④ 归来问候（gap ≥ 3 天） ─────────────────────
{
  console.log('\n—— ④ 归来问候 ——');
  const { userId, session } = globalThis.__m7a;
  const uKey = `u:${userId}`;
  await sql`UPDATE growth_profiles SET last_active_date = (now() - interval '5 days')::date WHERE user_key = ${uKey}`;
  const away = await page('/zh-CN/journey', session);
  check('隔 5 天回来 → 「欢迎回来。它还在」', away.html.includes('>欢迎回来。它还在'));
  check('不显示中断天数（不追责）', !away.html.includes('5 天'));

  await sql`UPDATE growth_profiles SET last_active_date = now()::date WHERE user_key = ${uKey}`;
  const today = await page('/zh-CN/journey', session);
  check('同天再访 → 不打扰', !today.html.includes('>欢迎回来。它还在'));
}

// ───────────────────── ⑤ 恢复码：生成 → 错码 → 对码 → 限速 ─────────────────────
{
  console.log('\n—— ⑤ 恢复码 ——');
  const { email, username, cookie: session } = await signUp();
  // 限速表清底（重跑冒烟时不被上一轮的 IP/账号计数卡住）
  await sql`DELETE FROM recovery_attempts`;
  const gen = await fetch(BASE + '/api/me/recovery/generate', { method: 'POST', headers: { Cookie: session } });
  const { code } = await gen.json();
  check('生成恢复码：4-4-4 十二位', gen.status === 200 && /^[-23456789A-Z]{14}$/.test(code), code);

  const rec = (c) =>
    fetch(BASE + '/api/me/recovery/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE },
      body: JSON.stringify({ username, code: c, newPassword: 'brand-new-pw-456' }),
    });

  for (let i = 0; i < 4; i++) {
    const bad = await rec('999999999999');
    check(`错码第 ${i + 1} 次 → 401`, bad.status === 401);
  }
  const good = await rec(code);
  check('第 5 次（对码）→ 重置成功', good.status === 200);

  const signin = await fetch(BASE + '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ email, password: 'brand-new-pw-456' }),
  });
  check('新密码能登录', signin.status === 200);
  const newSession = cookiesOf(signin);

  const sixth = await rec('999999999999');
  check('第 6 次 → 429（账号级 5 次/时限速）', sixth.status === 429);

  const oldKicked = await fetch(BASE + '/api/me/export', { headers: { Cookie: session } });
  check('重置密码后旧会话全部失效', oldKicked.status === 401);
  globalThis.__m7b = { email, session: newSession, username };
}

// ───────────────────── ⑥ 导出 + ⑦ 删除账号级联 ─────────────────────
{
  console.log('\n—— ⑥ 导出 ——');
  const { email, session, username } = globalThis.__m7b;
  // 该账号写一篇日记，确保导出有内容
  await fetch(BASE + '/api/journal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: session },
    body: JSON.stringify({ content: '导出前的一篇心事', locale: 'zh-CN' }),
  });
  const exp = await fetch(BASE + '/api/me/export', { headers: { Cookie: session } });
  const payload = await exp.json();
  check(
    '导出：JSON 附件 + 完整结构',
    exp.status === 200 &&
      (exp.headers.get('content-disposition') ?? '').includes('attachment') &&
      payload.format === 'money-freedom-living-export/v1' &&
      payload.account.email === email &&
      Array.isArray(payload.journal) &&
      payload.journal.some((j) => j.content === '导出前的一篇心事') &&
      Array.isArray(payload.conversations.messages)
  );

  console.log('\n—— ⑦ 删除账号级联 ——');
  const userId = (await sql`SELECT id FROM "user" WHERE email = ${email}`)[0].id;
  const uKey = `u:${userId}`;
  const del = await fetch(BASE + '/api/me/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: session },
    body: JSON.stringify({ confirm: 'DELETE' }),
  });
  check('删除成功', del.status === 200);

  const after = await sql`
    SELECT
      (SELECT count(*)::int FROM "user" WHERE id = ${userId}) AS u,
      (SELECT count(*)::int FROM account WHERE "userId" = ${userId}) AS a,
      (SELECT count(*)::int FROM growth_profiles WHERE user_key = ${uKey}) AS p,
      (SELECT count(*)::int FROM journal_entries WHERE user_key = ${uKey}) AS j,
      (SELECT count(*)::int FROM events WHERE user_key = ${uKey}) AS e,
      (SELECT count(*)::int FROM consent_records WHERE user_key = ${uKey}) AS c
  `;
  const x = after[0];
  check('级联清空：user/account/档案/日记/事件/同意记录全无', x.u + x.a + x.p + x.j + x.e + x.c === 0, JSON.stringify(x));
  const gone = await fetch(BASE + '/api/me/export', { headers: { Cookie: session } });
  check('删除后旧会话 401', gone.status === 401);
  console.log(`  （已删除 ${email} / ${username}）`);
}

// ───────────────────── ⑧ 隐私政策页 + /me 收尾 ─────────────────────
{
  console.log('\n—— ⑧ 隐私政策 ——');
  const zh = await page('/zh-CN/privacy');
  check('/privacy 中文版：标题 + 数据流 + 删除时间线 + 18+', zh.html.includes('隐私政策') && zh.html.includes('数据怎么流动') && zh.html.includes('30') && zh.html.includes('18'));
  const en = await page('/en/privacy');
  check('/privacy 英文版：Privacy Policy + data flow', en.html.includes('Privacy Policy') && en.html.includes('device'));
  const landing = await page('/zh-CN');
  check('landing 页脚有隐私政策入口', landing.html.includes('隐私政策'));
  const meGuest = await page('/zh-CN/me');
  check('/me 游客态：恢复码等说明已就位（不再是「即将可用」）', meGuest.html.includes('恢复码、数据导出与删除账号') && !meGuest.html.includes('即将可用'));
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 处失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
