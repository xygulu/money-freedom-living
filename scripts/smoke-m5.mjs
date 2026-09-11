// M5 冒烟：旅程三件事 + 日记 + 信件闭环（真实 LLM 调用）
//   ① 微行动完成 → experiments 落库 + 活跃足迹
//   ② 日记：写/存；游客回应 403（VIP 门禁）；VIP 真实回应 + 幂等；危机日记 → 转介回应
//   ③ 信件：写信 → AI 回信（不分析）；危机信 → 转介回信；封存/开启；非法流转 409
//   ④ /journey 三件事渲染 + daily_seen 幂等
// 运行：dev server 在 3000 + node --env-file=.env.local scripts/smoke-m5.mjs
import { neon } from '@neondatabase/serverless';
import { createHash } from 'node:crypto';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3000';
const sql = neon(process.env.DATABASE_URL);
let failures = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
  if (!cond) failures++;
}

/** 自带 32hex cookie 身份的游客（与 identity/quota 同构） */
class Guest {
  constructor(name) {
    this.name = name;
    this.id = crypto.randomUUID().replace(/-/g, '');
    this.key = `g:${this.id}`;
    this.cookie = `guest_qk=${this.id}`;
  }
  async req(path, method, body) {
    const response = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: this.cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const contentType = response.headers.get('content-type') ?? '';
    const json = contentType.includes('application/json') ? await response.json() : null;
    return { status: response.status, json, text: contentType.includes('text/html') ? await response.text() : null };
  }
  post(path, body) {
    return this.req(path, 'POST', body);
  }
  get(path) {
    return this.req(path, 'GET');
  }
  patch(path, body) {
    return this.req(path, 'PATCH', body);
  }
}

// ───────────────────────── ① 微行动 → experiments ─────────────────────────
{
  console.log('\n—— ① 微行动写入 experiments ——');
  const guest = new Guest('experiment');
  const res = await guest.post('/api/journey/experiment', {
    locale: 'zh-CN',
    action: '为自己花一笔纯粹开心的小钱',
    feeling: '付钱那一刻手有点紧，但后来是松的',
  });
  check('微行动完成接口 200', res.status === 200 && res.json?.ok === true);

  const profile = await sql`SELECT experiments, total_active_days FROM growth_profiles WHERE user_key = ${guest.key}`;
  const experiments = profile[0]?.experiments ?? [];
  check(
    'experiments 落库（date/action/feeling）',
    experiments.length === 1 &&
      experiments[0].action.includes('纯粹开心') &&
      experiments[0].feeling?.includes('松'),
    JSON.stringify(experiments.at(-1))
  );
  check('完成微行动计活跃足迹', Number(profile[0]?.total_active_days) >= 1);

  // 感受里带危机词：照常写入 + safety_events(source=experiment)
  const guest2 = new Guest('experiment-crisis');
  await guest2.post('/api/journey/experiment', {
    locale: 'zh-CN',
    action: '试着休息一晚上',
    feeling: '躺下来的时候突然觉得很累，有时候真的想死',
  });
  const ev = await sql`SELECT source, category FROM safety_events WHERE user_key = ${guest2.key} AND source = 'experiment'`;
  check('微行动感受过安全层（experiment 落事件）', ev.length === 1 && ev[0].category === 'crisis');
}

// ───────────────────────── ② 日记：写/存 + VIP 回应 ─────────────────────────
{
  console.log('\n—— ② 日记与 VIP 回应 ——');
  const guest = new Guest('journal');
  const saved = await guest.post('/api/journal', {
    locale: 'zh-CN',
    content: '今天发了工资，第一件事又是还信用卡。想给自己买束花，站在店门口五分钟又走了。',
  });
  check('日记写/存成功', saved.status === 200 && Number.isInteger(saved.json?.entry?.id));

  const rows = await sql`SELECT id, safety_hit FROM journal_entries WHERE user_key = ${guest.key}`;
  const entryId = rows[0]?.id;
  check('journal_entries 落库（safety_hit=false）', rows.length === 1 && rows[0].safety_hit === false);

  // 游客请求回应 → 403 vip_required（付费墙②的触发点，前端展示门禁文案）
  const gated = await guest.post(`/api/journal/${entryId}/reply`);
  check('游客请求回应 → 403 vip_required', gated.status === 403 && gated.json?.error === 'vip_required');

  // 危机日记：照常保存 + safety_hit；回应 = 转介（即使之后有 VIP 也不走 LLM）
  const crisisGuest = new Guest('journal-crisis');
  const crisis = await crisisGuest.post('/api/journal', {
    locale: 'zh-CN',
    content: '撑不住了，有时候真的想死。写下来好像好一点。',
  });
  check('危机日记照常保存 + safety 标记', crisis.status === 200 && crisis.json?.safety === true);
  const crisisRows = await sql`SELECT id, safety_hit FROM journal_entries WHERE user_key = ${crisisGuest.key}`;
  const crisisReply = await crisisGuest.post(`/api/journal/${crisisRows[0].id}/reply`);
  check('危机日记回应（游客也放行）= 转介文案', crisisReply.status === 200 && crisisReply.json?.reply?.includes('12356'));

  // VIP 真实回应：注册真实用户 + 种 entitlements
  //（better-auth 对写操作做 Origin 校验：脚本必须带 Origin 头，否则 403）
  const email = `m5-${crypto.randomUUID().slice(0, 8)}@smoke.test`;
  const signup = await fetch(BASE + '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ name: 'smoke', email, password: 'smoke-test-123' }),
  });
  const setCookie = signup.headers.get('set-cookie') ?? '';
  const sessionCookie = setCookie
    .split(',')
    .map((c) => c.split(';')[0].trim())
    .filter((c) => c.includes('='))
    .join('; ');
  check('测试用户注册成功', signup.ok, `status=${signup.status}`);

  const userRow = await sql`SELECT id FROM "user" WHERE email = ${email}`;
  const userId = userRow[0]?.id;
  await sql`
    INSERT INTO entitlements (user_id, vip_until) VALUES (${userId}, now() + interval '30 days')
    ON CONFLICT (user_id) DO UPDATE SET vip_until = now() + interval '30 days'
  `;
  const vipJournal = await fetch(BASE + '/api/journal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: JSON.stringify({ locale: 'zh-CN', content: '今天在公司楼下犹豫了很久要不要打车回家，最后还是坐了地铁，雨很大。' }),
  }).then((r) => r.json());
  const vipReply1 = await fetch(BASE + `/api/journal/${vipJournal.entry.id}/reply`, {
    method: 'POST',
    headers: { Cookie: sessionCookie },
  });
  const reply1 = await vipReply1.json();
  check('VIP 回应：LLM 真实回应', vipReply1.status === 200 && (reply1.reply?.length ?? 0) > 10, reply1.reply?.slice(0, 60));
  const vipReply2 = await fetch(BASE + `/api/journal/${vipJournal.entry.id}/reply`, {
    method: 'POST',
    headers: { Cookie: sessionCookie },
  }).then((r) => r.json());
  check('回应幂等（再次请求原样返回，不重复生成）', vipReply2.cached === true && vipReply2.reply === reply1.reply);
}

// ───────────────────────── ③ 信件闭环（回信不分析） ─────────────────────────
{
  console.log('\n—— ③ 信件闭环 ——');
  const guest = new Guest('letter');
  const sent = await guest.post('/api/letters', {
    locale: 'zh-CN',
    content: '亲爱的钱：我一直躲着你，账单来的时候我连拆开的勇气都没有。对不起，也谢谢你还在。',
  });
  const letter = sent.json?.letter;
  check('写信成功：信已收下（kept）+ 有回信', sent.status === 200 && letter?.state === 'kept' && (letter?.aiReply?.length ?? 0) > 10);
  console.log(`   回信：${letter?.aiReply}`);

  // 危机信：信照常收着，回信 = 转介
  const crisisGuest = new Guest('letter-crisis');
  const crisis = await crisisGuest.post('/api/letters', {
    locale: 'zh-CN',
    content: '写给钱：我真的撑不住了，有时候真的想死，只有想到你就更绝望。',
  });
  check('危机信：转介回信（不走 LLM）', crisis.json?.safety === true && crisis.json?.letter?.aiReply?.includes('12356'));
  const ev = await sql`SELECT source FROM safety_events WHERE user_key = ${crisisGuest.key} AND source = 'letter'`;
  check('letter 落安全事件', ev.length === 1);

  // 封存 → 开启；非法流转 409
  const seal = await guest.patch('/api/letters', { createdAt: letter.createdAt, action: 'seal' });
  check('封存成功（kept→sealed）', seal.status === 200 && seal.json?.state === 'sealed');
  const badOpen = await crisisGuest.patch('/api/letters', { createdAt: crisis.json.letter.createdAt, action: 'open' });
  check('kept 直接开启 → 409（简版只允许 sealed→opened）', badOpen.status === 409);
  const open = await guest.patch('/api/letters', { createdAt: letter.createdAt, action: 'open' });
  check('开启成功（sealed→opened）', open.status === 200 && open.json?.state === 'opened');

  const stored = await sql`SELECT letters FROM growth_profiles WHERE user_key = ${guest.key}`;
  const letters = stored[0]?.letters ?? [];
  check(
    '档案 letters 状态同步（opened）',
    letters.length === 1 && letters[0].state === 'opened' && (letters[0].aiReply ?? '').length > 0
  );
}

// ───────────────────────── ④ journey 页三件事 ─────────────────────────
{
  console.log('\n—— ④ /journey 渲染 ——');
  const guest = new Guest('journey');
  // 游客（无档案）：页面正常渲染三件事骨架
  const anon = await guest.get('/zh-CN/journey');
  check('无档案游客：journey 200 渲染', anon.status === 200 && anon.text?.includes('今日一签') && anon.text?.includes('今日微行动'));

  // 有档案用户：daily_seen 幂等（连续两次渲染只记一条当日）
  await guest.post('/api/onboarding/answers', {
    locale: 'zh-CN',
    answers: {
      moment_when: 'week',
      balance_feeling: 'avoid',
      childhood: '小时候家里说钱要省着花',
      payday_action: 'save',
      aspiration: 'relaxed',
      recent_worry: '不敢给自己花钱',
    },
  });
  await guest.get('/zh-CN/journey');
  await guest.get('/zh-CN/journey');
  const seen = await sql`SELECT daily_seen FROM growth_profiles WHERE user_key = ${guest.key}`;
  const entries = seen[0]?.daily_seen ?? [];
  const today = new Date().toISOString().slice(0, 10);
  check('一签 seen 记录且幂等（当日恰 1 条）', entries.filter((e) => e.date === today).length === 1, `共 ${entries.length} 条`);
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 处失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
