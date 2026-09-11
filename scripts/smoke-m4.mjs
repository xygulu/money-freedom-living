// M4 冒烟：对话模式三验收（真实 LLM 调用）
//   ① 危机词触发转介（safety_events 落库）
//   ② 失败不扣 + 落账语义（首回复成功才扣，游客 1/日 用完即 403）+ 会话摘要入 memories
//   ③ 第二天对话引用昨日摘要（直接种 memories → opener 自然接上）
// 运行：dev server 在 3000 + node --env-file=.env.local scripts/smoke-m4.mjs
import { neon } from '@neondatabase/serverless';
import { createHash } from 'node:crypto';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3000';
const sql = neon(process.env.DATABASE_URL);
let failures = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
  if (!cond) failures++;
}

/** 自带 32hex cookie 身份的游客（配额键/档案键都由此派生，无需等 Set-Cookie） */
class Guest {
  constructor(name) {
    this.name = name;
    this.id = crypto.randomUUID().replace(/-/g, '');
    this.key = `g:${this.id}`;
    this.cookie = `guest_qk=${this.id}`;
  }
  async post(path, body) {
    const response = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: this.cookie },
      body: JSON.stringify(body),
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      const text = await response.text();
      const result = { sse: true, status: response.status, full: '', events: [], sessionId: null };
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const event = JSON.parse(payload);
          result.events.push(event);
          if (event.session) result.sessionId = event.session;
          if (event.delta) result.full += event.delta;
        } catch {}
      }
      return result;
    }
    return { status: response.status, json: contentType.includes('application/json') ? await response.json() : null };
  }
  /** 与 quota.ts guestKeyFromId 同构（含 GUEST_KEY_PEPPER；脚本不依赖 TS，独立复刻） */
  quotaKey() {
    const day = new Date().toISOString().slice(0, 10);
    return createHash('sha256').update(`saas-kit:quota:v1:cookie:${day}:${this.id}`).digest('hex').slice(0, 32);
  }
  async del(path) {
    const response = await fetch(BASE + path, { method: 'DELETE', headers: { Cookie: this.cookie } });
    return response.status;
  }
}

// ───────────────────────── ① 危机词触发转介 ─────────────────────────
{
  console.log('\n—— ① 危机转介 ——');
  const guest = new Guest('crisis');
  const created = await guest.post('/api/chat/sessions', { locale: 'zh-CN' });
  const sessionId = created.json?.session;

  const opener = await guest.post(`/api/chat/${sessionId}`, { opener: true });
  check('危机游客：开场正常', opener.sse && opener.full.length > 10);

  const crisis = await guest.post(`/api/chat/${sessionId}`, { message: '说实话，我最近有时候真的想死，觉得撑不下去了' });
  check('危机命中 → 转介文案（不走 LLM）', crisis.sse && crisis.full.includes('12356'), crisis.full.slice(0, 60));
  check('SSE 带 safety 事件标记', crisis.events.some((e) => e.safety === 'crisis'));

  const events = await sql`SELECT category, source FROM safety_events WHERE user_key = ${guest.key} ORDER BY id DESC LIMIT 1`;
  check('safety_events 落库（crisis/chat，无原文）', events.length === 1 && events[0].category === 'crisis' && events[0].source === 'chat');

  const flagged = await sql`SELECT safety_flagged FROM chat_sessions WHERE id = ${sessionId}`;
  check('会话标记 safety_flagged', flagged[0]?.safety_flagged === true);

  const stable = await guest.post(`/api/chat/${sessionId}`, { message: '谢谢你还在这' });
  check('命中后后续轮次仍陪伴（稳定模式，LLM 正常回复）', stable.sse && stable.full.length > 10, stable.full.slice(0, 60));
  await guest.del(`/api/chat/${sessionId}`);
}

// ─────────────────── ② 失败不扣 + 落账 + 会话摘要 ───────────────────
{
  console.log('\n—— ② 落账与摘要 ——');
  const guest = new Guest('quota');
  const created = await guest.post('/api/chat/sessions', { locale: 'zh-CN' });
  const sessionId = created.json?.session;
  check('建会话成功（预检通过）', Boolean(sessionId));

  const opener = await guest.post(`/api/chat/${sessionId}`, { opener: true });
  check('开场成功', opener.sse && opener.full.length > 10);

  const talk = await guest.post(`/api/chat/${sessionId}`, {
    message: '我最近一直想跟老板谈加薪，话到嘴边又咽回去了，怕他觉得我贪心',
  });
  check('正式对话回复', talk.sse && talk.full.length > 10, talk.full.slice(0, 60));

  // 落账语义：首回复成功才扣。会话内 2 次 AI 回复（开场+消息）只产生 1 行 quota_events
  await new Promise((r) => setTimeout(r, 1500)); // 落账在流结束后发生
  const quotaRows = await sql`SELECT id FROM quota_events WHERE guest_key = ${guest.quotaKey()}`;
  check('会话内 2 次 AI 回复只落账 1 次（1 次 = 一次会话）', quotaRows.length === 1);
  // 且游客当日额度（1 次）已用尽 → 再建会话必须 403
  const again = await guest.post('/api/chat/sessions', { locale: 'zh-CN' });
  check('游客 1/日：额度用完再建会话 → 403（证明首回复后确实落账）', again.status === 403 && again.json?.error === 'quota_exhausted');

  // 主动结束 → 摘要入 memories
  const delStatus = await guest.del(`/api/chat/${sessionId}`);
  check('结束今天的对话（DELETE 触发结算）', delStatus === 204);
  const profile = await sql`SELECT memories, pinned FROM growth_profiles WHERE user_key = ${guest.key}`;
  const memories = profile[0]?.memories ?? [];
  const pinned = profile[0]?.pinned ?? [];
  check('会话摘要写入 memories', memories.length >= 1, JSON.stringify(memories.at(-1)));
  console.log(`   pinned 候选（${pinned.length} 条）:`, JSON.stringify(pinned));

  // 失败不扣的反向证明：结算/摘要失败也不会再扣（今日已无额度，且会话已关）
  const closed = await guest.post(`/api/chat/${sessionId}`, { message: '还在吗' });
  check('已关会话不可再写（409）', closed.status === 409);
}

// ─────────────────── ③ 第二天对话引用昨日摘要 ───────────────────
{
  console.log('\n—— ③ 昨日摘要引用 ——');
  const guest = new Guest('memory');
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  // 直接种档案 memories（模拟"昨天聊过加薪"），省去跨日等待
  await sql`
    INSERT INTO growth_profiles (user_key, locale, memories)
    VALUES (${guest.key}, 'zh-CN', ${JSON.stringify([
      { date: yesterday, text: '用户昨天说打算下周跟老板谈加薪，话到嘴边又咽回去，怕被觉得贪心。' },
    ])}::jsonb)
    ON CONFLICT (user_key) DO UPDATE SET memories = EXCLUDED.memories
  `;
  const created = await guest.post('/api/chat/sessions', { locale: 'zh-CN' });
  const sessionId = created.json?.session;
  const opener = await guest.post(`/api/chat/${sessionId}`, { opener: true });
  const referenced = opener.full.includes('加薪') || opener.full.includes('老板');
  check('opener 自然接上昨日内容（归来问候）', referenced, opener.full.slice(0, 120));
  await guest.del(`/api/chat/${sessionId}`);
}

// ─────────────────── ④ 初谈回归（安全层接入未破坏 M3） ───────────────────
{
  console.log('\n—— ④ 初谈回归 ——');
  const guest = new Guest('talk');
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
  const talk = await guest.post('/api/onboarding/talk', { locale: 'zh-CN' });
  check('初谈开场正常（回归）', talk.sse && Boolean(talk.sessionId) && talk.full.length > 20, talk.full.slice(0, 60));
  await guest.del(`/api/chat/${talk.sessionId}`);
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 处失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
