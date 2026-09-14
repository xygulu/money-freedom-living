// P0-1 每日两问协议 + 五类失败接法的真模型冒烟（docs/10 §1.3 明写「这在 vitest 里做不了」）。
//
// vitest 只能断言"约束文本进了 system"；能不能管住模型是另一回事。这个脚本造 6 个真实会话
// （五类失败各一 + 一条正常走完两问的对照），把**AI 的下一句**原样打出来。
// 判定不在这里做：这里只打印，人读着判。脚本自动验的只有两条能机检的硬规则——
//   ① 「没做」那一类的回应里不许出现安慰/鼓励/明天
//   ② 任何一条回复里不许出现两个问号（"不同时出现"）
// 其余（顺序是否先行为后认知、是否只是接住而非追问）留给眼睛。
//
// 运行：dev server 在 3000（必须用 localhost，别用 127.0.0.1——allowedDevOrigins 会让
//       带 Origin 的 127.0.0.1 请求 chunk 返 403）
//   node --env-file=.env.local scripts/smoke-p0-daily-two-questions.mjs
import * as crypto from 'crypto';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3000';
const LOCALE = process.env.SMOKE_LOCALE ?? 'zh-CN';
let failures = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
  if (!cond) failures++;
}

function cookiesOf(res) {
  // 只能用 getSetCookie()：Expires 里带逗号，按 ',' 切会把 Cookie 切坏（游客 key 就是这么丢的）
  const list = res.headers.getSetCookie?.() ?? [];
  return list
    .map((c) => c.split(';')[0].trim())
    .filter((c) => c.includes('='))
    .join('; ');
}

/** 一次对话：建会话 → 发消息 → 收 SSE 全文 */
async function say(cookie, sessionId, message) {
  const res = await fetch(`${BASE}/api/chat/${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: BASE },
    body: JSON.stringify({ message, locale: LOCALE }),
  });
  if (!res.ok) return { text: `[HTTP ${res.status}] ${await res.text()}`, ok: false };
  const raw = await res.text();
  // SSE：逐行取 data: 的 JSON，拼 delta；只关心文本，其余事件（session/wrap/safety）跳过
  let text = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const evt = JSON.parse(line.slice(5).trim());
      if (typeof evt.delta === 'string') text += evt.delta;
    } catch {
      /* 非 JSON 的心跳/注释行 */
    }
  }
  return { text: text.trim(), ok: true };
}

async function newGuest(locale) {
  // 游客 key（guest_qk）由 /api/chat/sessions 首次种下（quota.ts 的 httpOnly 90 天 cookie），
  // 所以一次调用把 cookie 和 session 一起拿回来——分两步反而会各建一个身份。
  const res = await fetch(`${BASE}/api/chat/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ locale }),
  });
  if (!res.ok) throw new Error(`建会话失败 HTTP ${res.status}：${await res.text()}`);
  const cookie = cookiesOf(res) || cookiesOf(await fetch(`${BASE}/${locale}/journey`, { redirect: 'manual' }));
  if (!cookie.includes('guest_qk')) throw new Error(`没拿到游客 cookie：${cookie || '(空)'}`);
  return { cookie, session: (await res.json()).session };
}

// ───────────── 六个会话 ─────────────
// 每个会话第一句是"他开的口"，第二句模拟他对着这一格的三行回答。
// 第五、六类只需要一轮（情绪为负 / 正常走完）。
const CASES = [
  {
    key: '说没做',
    turns: ['今天那个练习我没做。', '没做。'],
    rule: '不许安慰、不许鼓励、不许提明天',
    check(line) {
      const bad = ['没关系', '不要紧', '慢慢来', '明天', '加油', '已经很', '下次', '别自责', '辛苦了'];
      return bad.filter((w) => line.includes(w));
    },
  },
  {
    key: '不知道',
    turns: ['我不知道该说什么。', '不知道。'],
    rule: '不许换个说法把同一个问题再问一遍',
    check() {
      return [];
    },
  },
  {
    key: '只回一个字',
    turns: ['那个练习做了。', '嗯。'],
    rule: 'AI 也要短，不许替他把话填满',
    check(line) {
      return line.length > 60 ? [`回复 ${line.length} 字，太长了`] : [];
    },
  },
  {
    key: '反问回来',
    turns: ['我不想聊这个。', '你觉得我该怎么做？'],
    rule: '答完就停，不许拿他的问题当跳板绕回自己的提问',
    check(line) {
      return line.includes('？') && line.split('？').length > 2 ? ['回复里不止一个问句'] : [];
    },
  },
  {
    key: '情绪为负',
    turns: ['今天做完反而更难受了。'],
    rule: '先待在情绪里，这一轮不给建议',
    check(line) {
      const bad = ['建议你', '你可以试试', '不妨', '其实你可以'];
      return bad.filter((w) => line.includes(w));
    },
  },
  {
    key: '正常走完两问',
    turns: ['今天那件事我做了。', '做了。想到我妈那句"咱家不配"，我第一句话是"那我凭什么"。'],
    rule: '先行为后认知，一天两问封顶',
    check() {
      return [];
    },
  },
];

console.log(`\n—— 每日两问协议真模型冒烟（${LOCALE}）——`);
console.log('判定方式：逐条读下面打印出来的 AI 原话。自动只机检两条硬规则。\n');

for (const c of CASES) {
  console.log(`\n=== 【${c.key}】${c.rule} ===`);
  let cookie;
  let session;
  try {
    ({ cookie, session } = await newGuest(LOCALE));
  } catch (e) {
    check(`【${c.key}】建会话`, false, String(e).slice(0, 120));
    continue;
  }
  for (const [i, msg] of c.turns.entries()) {
    const r = await say(cookie, session, msg);
    console.log(`  他说：${msg}`);
    console.log(`  AI  ：${r.text || '(空)'}`);
    if (!r.ok) {
      check(`【${c.key}】第 ${i + 1} 轮拿到回复`, false, r.text.slice(0, 120));
      continue;
    }
    // 机检两条：问号数量、该类的禁用词
    const q = (r.text.match(/[？?]/g) ?? []).length;
    if (q > 1) check(`【${c.key}】第 ${i + 1} 轮：一条回复里不超过一个问句`, false, `${q} 个问号`);
    const bad = c.check(r.text);
    if (bad.length) check(`【${c.key}】第 ${i + 1} 轮：${c.rule}`, false, `命中 ${bad.join('/')}`);
  }
}

console.log(`\n${failures === 0 ? '机检全过（人工仍需逐条读一遍上面的话）' : `${failures} 处机检不过`}\n`);
process.exit(failures === 0 ? 0 : 1);
