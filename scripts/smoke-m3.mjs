// M3 冒烟：走完 问卷→初谈→确认→画像→校准 全流程（真实 LLM 调用）
// 运行：node --env-file=.env.local scripts/smoke-m3.mjs（dev server 需在 3000 跑着）
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3000';
let cookie = '';

async function api(path, body) {
  const response = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    // SSE：收集 session 与全文
    const text = await response.text();
    let sessionId = null;
    let full = '';
    let sseError = null;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const event = JSON.parse(payload);
        if (event.session) sessionId = event.session;
        if (event.delta) full += event.delta;
        if (event.error) sseError = event.error;
      } catch {}
    }
    return { sse: true, sessionId, full, sseError, status: response.status };
  }
  const json = contentType.includes('application/json') ? await response.json() : null;
  return { status: response.status, json };
}

function check(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

// ---- 1. 问卷 ----
const answers = await api('/api/onboarding/answers', {
  locale: 'zh-CN',
  answers: {
    moment_when: 'cant_remember',
    balance_feeling: 'avoid',
    childhood: '小时候我妈总说「咱家不配」，想要什么都会被说不懂事，后来我就不敢要了',
    payday_action: 'repay',
    aspiration: 'relaxed',
    recent_worry: '上周给自己买了件三百块的外套，内疚了三天',
  },
});
check('问卷落库', answers.status === 200 && answers.json?.ok === true);

// ---- 2. 初谈开场（SSE）----
const talk = await api('/api/onboarding/talk', { locale: 'zh-CN' });
check('初谈会话创建+开场流式', talk.sse && talk.sessionId && talk.full.length > 20, `开场：${talk.full.slice(0, 80)}…`);
const sessionId = talk.sessionId;

// ---- 3. 初谈两轮 ----
const reply1 = await api(`/api/chat/${sessionId}`, { message: '对，就是那种感觉。现在买了东西回家都不敢跟我妈说价格，虽然我已经三十多了' });
check('初谈第 1 轮回复', reply1.sse && reply1.full.length > 20, `：${reply1.full.slice(0, 80)}…`);
const reply2 = await api(`/api/chat/${sessionId}`, { message: '最重的一次是上个月买外套，付完钱手一直在抖，我躲在试衣间里缓了很久' });
check('初谈第 2 轮回复', reply2.sse && reply2.full.length > 20, `：${reply2.full.slice(0, 80)}…`);

// ---- 4. 「我听到的是」----
const reflect = await api('/api/onboarding/reflect', { sessionId, locale: 'zh-CN' });
check('我听到的是（复述）', reflect.status === 200 && (reflect.json?.summary ?? '').length > 30, `：${(reflect.json?.summary ?? '').slice(0, 80)}…`);

// ---- 5. 画像生成 ----
// consent: true —— 敏感信息单独同意（P§9）是画像生成的硬前置；M11-C 后它排在
// 「我听到的是…」之后（先被说中 → 再同意），顺序与前端一致
const portrait = await api('/api/onboarding/portrait', { sessionId, locale: 'zh-CN', consent: true });
const p = portrait.json?.portrait;
check('画像生成', portrait.status === 200 && Boolean(p?.baseColor && p?.script && p?.spoken?.length >= 1 && p?.moments?.length >= 1));
if (p) {
  console.log('\n----- 画像 v1 -----');
  console.log('你说过的:', p.spoken);
  console.log('底色:', p.baseColor);
  console.log('瞬间:', p.moments.map((m) => `${m.title}（${m.detail}）`));
  console.log('脚本:', p.script);
  console.log('给未来:', p.toFuture, '\n');
}

// ---- 6. 校准 ----
const calibrate = await api('/api/onboarding/calibrate', { section: 'script', verdict: 'hit' });
check('校准写回（脚本确认）', calibrate.status === 200 && calibrate.json?.portrait?.scriptStatus === 'confirmed');
const calibrate2 = await api('/api/onboarding/calibrate', { section: 'spoken:0', verdict: 'miss', correction: '我妈说的是「咱家跟别人家不一样」' });
check('校准写回（原话修正）', calibrate2.status === 200 && calibrate2.json?.portrait?.spoken?.[0] === '我妈说的是「咱家跟别人家不一样」');
