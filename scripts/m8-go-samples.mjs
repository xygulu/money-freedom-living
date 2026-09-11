// M8 Go/No-Go：①en 盲测样本——真实 chat 管线批量出样（真实 LLM/真实上下文组装），
// 供人工盲评语气与分寸；②单位经济数据源——配合 llm.ts 的 [llm] usage 日志，
// 跑完这批真实对话后从 dev 日志聚合每轮 token，算免费/VIP 月成本。
// 运行：dev server 在 3000 + node --env-file=.env.local scripts/m8-go-samples.mjs [dev日志路径]
import * as crypto from 'crypto';
import * as fs from 'fs';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3000';
const DEV_LOG = process.argv[2] ?? '/tmp/claude-0/-root/025ee60f-6a8a-4b8b-9990-ce6f66d42756/tasks/brh386a5o.output';
const logOffset = fs.existsSync(DEV_LOG) ? fs.statSync(DEV_LOG).size : 0;

function cookiesOf(res) {
  return (res.headers.get('set-cookie') ?? '')
    .split(',')
    .map((c) => c.split(';')[0].trim())
    .filter((c) => c.includes('='))
    .join('; ');
}
async function sseText(res) {
  const raw = await res.text();
  return raw
    .split('\n\n')
    .map((blk) => blk.replace(/^data:\s*/, '').trim())
    .filter((s) => s.startsWith('{'))
    .map((s) => JSON.parse(s))
    .map((e) => (typeof e.delta === 'string' ? e.delta : ''))
    .join('');
}
async function signUp(tag) {
  const n = crypto.randomUUID().slice(0, 8).replace(/-/g, '');
  const res = await fetch(BASE + '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ name: `go${tag}${n}`, username: `go${tag}${n}`, email: `go${tag}${n}@smoke.test`, password: 'smoke-test-123' }),
  });
  if (res.status !== 200) throw new Error(`signup ${res.status}`);
  return cookiesOf(res);
}
async function openChat(cookie, locale) {
  const res = await fetch(BASE + '/api/chat/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ locale }),
  });
  const { session } = await res.json();
  if (!session) throw new Error(`open session ${res.status}`);
  return session;
}
async function sendOpener(cookie, sessionId) {
  const res = await fetch(`${BASE}/api/chat/${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ opener: true }),
  });
  return sseText(res);
}
async function send(cookie, sessionId, message) {
  const res = await fetch(`${BASE}/api/chat/${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ message }),
  });
  if (res.status !== 200) return `（HTTP ${res.status}）`;
  return sseText(res);
}

// en 盲测输入：覆盖主要金钱情结场景，长度/情绪浓度各异，无安全层触发词
const EN_TURNS = [
  "Payday used to feel like a finish line. Now it just feels like the day the money leaves again. I don't even open the banking app until days after.",
  'My mother calls it being sensible, putting money aside. I hear "you are never enough" every single time.',
  'Honestly, I get a little high when a big order comes in for my side project. Then I spend it within the week, like the money was never really mine.',
  "I stood in a department store holding a coat I didn't need, and I heard her voice saying we can't afford it. I'm thirty-four years old.",
  'Last month was the first time I paid off a credit card in full. Nobody noticed. I want someone to know it took me nine years.',
  "Some days I feel nothing about numbers at all. Spreadsheets, debts, salary — it's all gray. Is that burnout or just me being lazy?",
  'My partner and I keep fighting about a coffee machine. It is never about the coffee machine.',
  'If this keeps going the way it is, I think I could actually put away a little each month. Small, but mine.',
];

const ZH_TURNS = [
  '发工资那天我请全组喝了奶茶，第二天就开始吃泡面。我妈说我从小就这样，穷大方。',
  '我算了一下，如果我不再给家里打钱，三年就能还清。这个念头让我觉得自己很坏。',
  '今天把花呗结清了，就剩下一张卡。想找个人说说话，不用夸我，就是想说一下。',
];

// ja 盲测输入（M8 定义：LLM en/ja 盲测）
const JA_TURNS = [
  '給料日なのに、いつも嬉しくないんです。お金が入っても、すぐに引き落としで消えていく。私って何のために働いてるんだろうって思います。',
  '母からよく「浪費してどうするの」と言われました。今でもレジで会計するとき、まるで見張られているような気持ちになります。',
  '先月、初めて貯金が10万円を超えました。誰にも言えなかったけど、ここに書きたくなって。',
  '同僚はみんな気軽にランチに誘ってくれるけど、私は毎回計算してしまう。断ると空気が悪くなるし、ついていくと心が痛いし。',
  '投資を始めたほうがいいと分かっているのに、手が出せません。失敗が怖いというより、お金を増やしてもいい気がしないんです。',
];

const samples = { en: [], 'zh-CN': [], ja: [] };

// ── en 盲测样本（盲评主对象）──
const cookieEn = await signUp('e');
const enSession = await openChat(cookieEn, 'en');
console.log(`en opener…`);
samples.en.push({ user: null, reply: (await sendOpener(cookieEn, enSession)).trim() });
for (const turn of EN_TURNS) {
  console.log(`en turn…`);
  samples.en.push({ user: turn, reply: (await send(cookieEn, enSession, turn)).trim() });
}

// ── zh 参照样例（小批量）──
const cookieZh = await signUp('z');
const zhSession = await openChat(cookieZh, 'zh-CN');
samples['zh-CN'].push({ user: null, reply: (await sendOpener(cookieZh, zhSession)).trim() });
for (const turn of ZH_TURNS) {
  console.log(`zh turn…`);
  samples['zh-CN'].push({ user: turn, reply: (await send(cookieZh, zhSession, turn)).trim() });
}

// ── ja 盲测样本 ──
const cookieJa = await signUp('j');
const jaSession = await openChat(cookieJa, 'ja');
console.log(`ja opener…`);
samples.ja.push({ user: null, reply: (await sendOpener(cookieJa, jaSession)).trim() });
for (const turn of JA_TURNS) {
  console.log(`ja turn…`);
  samples.ja.push({ user: turn, reply: (await send(cookieJa, jaSession, turn)).trim() });
}

// ── 收尾结算（摘要入 memories，也是单位经济的一部分：每会话一次）──
await fetch(`${BASE}/api/chat/${enSession}`, { method: 'DELETE', headers: { Cookie: cookieEn } });
await fetch(`${BASE}/api/chat/${zhSession}`, { method: 'DELETE', headers: { Cookie: cookieZh } });
await fetch(`${BASE}/api/chat/${jaSession}`, { method: 'DELETE', headers: { Cookie: cookieJa } });

// ── 从 dev 日志聚合 [llm] usage ──
const tail = fs.existsSync(DEV_LOG) ? fs.readFileSync(DEV_LOG, 'utf8').slice(logOffset) : '';
const usages = [...tail.matchAll(/\[llm\] usage kind=(\w+) .*? in=(\d+|\?) out=(\d+|\?)/g)].map(
  (m) => ({ kind: m[1], in: m[2] === '?' ? NaN : Number(m[2]), out: m[3] === '?' ? NaN : Number(m[3]) })
);
const stat = (list, key) => {
  const vals = list.map((u) => u[key]).filter((v) => Number.isFinite(v));
  const sum = vals.reduce((a, b) => a + b, 0);
  return { n: vals.length, avg: vals.length ? Math.round(sum / vals.length) : 0, sum };
};
const streams = usages.filter((u) => u.kind === 'stream');
const completes = usages.filter((u) => u.kind === 'complete');
const econ = {
  measuredAt: new Date().toISOString(),
  chatTurns: { count: stat(streams, 'in').n, avgInputTokens: stat(streams, 'in').avg, avgOutputTokens: stat(streams, 'out').avg, sumInput: stat(streams, 'in').sum, sumOutput: stat(streams, 'out').sum },
  nonChatCalls: { count: stat(completes, 'in').n, avgInputTokens: stat(completes, 'in').avg, avgOutputTokens: stat(completes, 'out').avg },
};

// ── 输出 ──
const out = { ...samples, econ };
fs.writeFileSync('/tmp/m8-go-samples.json', JSON.stringify(out, null, 2));
console.log('\n==== 单位经济原始数据（真实管线实测）====');
console.log(JSON.stringify(econ, null, 2));
console.log(`\n样本已写 /tmp/m8-go-samples.json（en ${samples.en.length}，zh ${samples["zh-CN"].length}，ja ${samples.ja.length}）`);
