// M11-A/B 冒烟（多书架构的数据模型 + 内容层书维度，docs/05 §10 验收 A/B）：
// ① 零新表——三列全落 growth_profiles 行内 + portrait_versions.book_id +
//    consent_records.kind（DEFAULT 'sensitive'）+ 复合索引都在场；
// ② 命题线随评估确认落库（灯归书、程度归人）：stage1 三盏全亮 → parents /
//    self-worth / inner-turmoil 三条命题线 depth=mastered、evidence 带 bookId 与原话；
//    再确认一份"只亮一盏、非全亮"的 stage2 评估 → 程度只增不减、原话追加；
// ③ 触达同意与敏感信息同意互不污染（kind 隔离，docs/05 §9.3）；
// ④ 【最重要】存量用户零变化：一条"DDL 回填后的存量行"（books/threads/touch
//    全取 DEFAULT）导出后，画像/灯/足迹/信/心印/一签去重逐项与种子一致，
//    profile 的键集只比 M10 多出 books/threads/touch 三个，别处零差异。
// ⑤ 上手路径前置（M11-C）：问卷交完就给「我听到的是…」，同意挪到被说中之后；
// ⑥ 日频形态（M11-D）：日常页是「开→做→合」一段且有明确收束、四段是区域不是
//    进度条、灯图带命题维度、书只在「你走过的路」露面（出处与邀请）。
// 运行：dev server 在 3000 + node --env-file=.env.local scripts/smoke-m11.mjs
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

const day = 86_400_000;
const daysAgo = (n) => new Date(Date.now() - n * day).toISOString();
const dayStr = (n) => daysAgo(n).slice(0, 10);

async function signUp(tag) {
  const email = `m11-${tag}-${crypto.randomUUID().slice(0, 8)}@smoke.test`;
  const username = `smoke11${crypto.randomUUID().slice(0, 6)}`;
  const res = await fetch(BASE + '/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ name: username, username, email, password: 'smoke-test-123' }),
  });
  const cookie = cookiesOf(res);
  const userId = (await sql`SELECT id FROM "user" WHERE email = ${email}`)[0].id;
  return { email, cookie, userId, key: `u:${userId}` };
}

const get = (path, cookie) => fetch(BASE + path, { headers: { Cookie: cookie } });
const post = (path, body, cookie) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });

const threadsOf = (key) =>
  sql`SELECT threads FROM growth_profiles WHERE user_key = ${key}`.then((r) => r[0]?.threads ?? {});

const BOOK_ID = 'money-freedom';
const TOPICS = ['self-worth', 'parents', 'inner-turmoil', 'boundaries', 'money-safety', 'allowing'];

// ───────────────────── ① 零新表：五处 DDL 都在场 ─────────────────────
console.log('\n—— ① 数据模型：三列落行内 + book_id + consent kind（零新表）——');
const cols = await sql`
  SELECT table_name, column_name, is_nullable, column_default
  FROM information_schema.columns
  WHERE (table_name = 'growth_profiles' AND column_name IN ('books','threads','touch'))
     OR (table_name = 'portrait_versions' AND column_name = 'book_id')
     OR (table_name = 'consent_records' AND column_name = 'kind')`;
const col = (t, c) => cols.find((x) => x.table_name === t && x.column_name === c);
check(
  'growth_profiles.books / threads / touch 三列在场且 NOT NULL 带默认值（存量行被 DDL 回填，不是 NULL）',
  ['books', 'threads', 'touch'].every((c) => {
    const found = col('growth_profiles', c);
    return found && found.is_nullable === 'NO' && String(found.column_default ?? '').includes(c === 'books' ? '[]' : '{}');
  }),
  cols.filter((x) => x.table_name === 'growth_profiles').map((x) => `${x.column_name}=${x.column_default}`).join(' ')
);
check('portrait_versions.book_id 在场（画像快照记下当时在读哪本书）', Boolean(col('portrait_versions', 'book_id')));
check(
  "consent_records.kind 在场且默认 'sensitive'（存量同意语义不变）",
  Boolean(col('consent_records', 'kind')) && String(col('consent_records', 'kind').column_default ?? '').includes('sensitive')
);
const idx = await sql`SELECT indexname FROM pg_indexes WHERE tablename = 'consent_records' AND indexname = 'idx_consent_user_kind'`;
check('consent(user_key, kind, created_at) 复合索引在场', idx.length === 1);
const newTables = await sql`
  SELECT count(*)::int AS n FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name IN ('books','user_books','threads','thread_evidence','touch_log','user_touch')`;
check('没有为多书/触达新建任何表（零新表）', newTables[0].n === 0);

// ───────────────────── ② 命题线：随评估确认落库，程度只增不减 ─────────────────────
console.log('\n—— ② 命题线（灯归书 / 程度归人 / 跨书累加只增不减）——');
const th = await signUp('threads');
const Q_STORY = 'M11 依据：家里的账单总摊在饭桌上';
const Q_SCRIPT = 'M11 依据：你说那不是债，是怕花完就没有';
const Q_COLOR = 'M11 依据：一花钱就想起妈妈叹气的样子';
const Q_CLAIM = 'M11 依据：这次你说"我值这个价"没有改口';
const portrait = {
  spoken: ['M11 原话：我一花钱就有罪恶感'],
  baseColor: 'M11 底色：总觉得自己不配花这笔钱',
  moments: [],
  script: '也许钱是要还的债',
  toFuture: '',
  version: 1,
  calibrations: [],
  scriptStatus: 'confirmed',
  createdAt: daysAgo(20),
};
const pendingStage1 = {
  actualStage: 2,
  lamps: [
    { kind: 'stage1_story', lit: true, evidence: Q_STORY },
    { kind: 'stage1_script', lit: true, evidence: Q_SCRIPT },
    { kind: 'stage1_color', lit: true, evidence: Q_COLOR },
  ],
  summary: 'M11 总结：它看见你把这个故事讲完了。',
  diagnosis: 'M11 诊断：故事、剧本、底色都露了面。',
  distance: 'M11 距离：你已经敢看它了。',
  actions: ['M11 行动：把那件舍不得用的东西用起来。'],
  nextHint: '',
  assessedAt: daysAgo(1),
};
const emptyState = { pending: null, confirmed: null, confirmedAt: null, dismissedAt: null, generatingAt: null, proposedSeenAt: null, previousConfirmed: null, changeList: null, changeListLockAt: null };
await sql`
  INSERT INTO growth_profiles (user_key, locale, portrait, concerns, stage, stage_started_at,
    pinned, memories, experiments, letters, stamps, portrait_evolution, stage_assessment, created_at, daily_seen)
  VALUES (${th.key}, 'zh-CN', ${JSON.stringify(portrait)}::jsonb, '[]'::jsonb, 1, ${daysAgo(20)},
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
    ${JSON.stringify({ ...emptyState, pending: pendingStage1 })}::jsonb, ${daysAgo(20)}, '[]'::jsonb)`;

const confirm1 = await post('/api/journey/assess', { locale: 'zh-CN', action: 'confirm' }, th.cookie);
check('确认 stage1 评估（三盏全亮 → 随确认开启下一阶段）', confirm1.status === 200);
const t1 = await threadsOf(th.key);
check(
  '三盏灯按命题落到 threads：parents / self-worth / inner-turmoil',
  ['parents', 'self-worth', 'inner-turmoil'].every((k) => t1[k]),
  Object.keys(t1).join(',')
);
check(
  '本阶段全亮 → 这几条命题线的程度 = mastered（走完过这条线）',
  ['parents', 'self-worth', 'inner-turmoil'].every((k) => t1[k]?.depth === 'mastered')
);
check(
  '原话入档且标了是哪本书的哪盏灯（灯归书）',
  t1['self-worth']?.evidence?.[0]?.quote === Q_SCRIPT &&
    t1['self-worth']?.evidence?.[0]?.bookId === BOOK_ID &&
    t1['self-worth']?.evidence?.[0]?.ref === 'stage1_script' &&
    t1['self-worth']?.evidence?.[0]?.source === 'assessment',
  JSON.stringify(t1['self-worth']?.evidence?.[0] ?? null)
);
check('firstSeenAt / lastSeenAt 都记下了', Boolean(t1['parents']?.firstSeenAt) && Boolean(t1['parents']?.lastSeenAt));

// 第二次：stage2 只亮一盏（self-worth），非全亮 → 程度算出来是 seen
const stageNow = (await sql`SELECT stage FROM growth_profiles WHERE user_key = ${th.key}`)[0].stage;
check('三盏全亮后阶段已推进到 2', stageNow === 2, `stage=${stageNow}`);
const pendingStage2 = {
  actualStage: 2,
  lamps: [
    { kind: 'stage2_claim', lit: true, evidence: Q_CLAIM },
    { kind: 'stage2_try', lit: false, evidence: '' },
    { kind: 'stage2_voice', lit: false, evidence: '' },
  ],
  summary: 'M11 总结二：你开始说自己值这个价了。',
  diagnosis: 'M11 诊断二：只走到"敢说"，还没走到"敢要"。',
  distance: 'M11 距离二：还差一次真的开口。',
  actions: ['M11 行动二：跟一个人说出你的价。'],
  nextHint: '',
  assessedAt: new Date().toISOString(),
};
await sql`
  UPDATE growth_profiles
  SET stage_assessment = stage_assessment || ${JSON.stringify({ pending: pendingStage2 })}::jsonb
  WHERE user_key = ${th.key}`;
const confirm2 = await post('/api/journey/assess', { locale: 'zh-CN', action: 'confirm' }, th.cookie);
check('确认 stage2 评估（只亮一盏，不推进）', confirm2.status === 200);
const t2 = await threadsOf(th.key);
check(
  '同一条命题线再次被点到：程度只增不减（mastered 不会被 seen 覆盖）',
  t2['self-worth']?.depth === 'mastered',
  `depth=${t2['self-worth']?.depth}`
);
check(
  '新原话追加在后面，旧原话还在（证据只增不减）',
  t2['self-worth']?.evidence?.length === 2 &&
    t2['self-worth']?.evidence?.[0]?.quote === Q_SCRIPT &&
    t2['self-worth']?.evidence?.[1]?.quote === Q_CLAIM,
  `n=${t2['self-worth']?.evidence?.length}`
);
check('没被点到的命题线原样不动', JSON.stringify(t2['parents']) === JSON.stringify(t1['parents']));

// ───────────────────── ③ 触达同意 ≠ 敏感信息同意 ─────────────────────
console.log('\n—— ③ 同意的两件事互不污染（kind 隔离）——');
await sql`INSERT INTO consent_records (user_key, granted, policy_version, ip_hash, kind)
          VALUES (${th.key}, true, 'smoke', null, 'touch')`;
await sql`INSERT INTO consent_records (user_key, granted, policy_version, ip_hash)
          VALUES (${th.key}, false, 'smoke', null)`;
const kinds = await sql`
  SELECT kind, granted FROM consent_records WHERE user_key = ${th.key} ORDER BY id DESC`;
const latestSensitive = kinds.find((r) => r.kind === 'sensitive');
const latestTouch = kinds.find((r) => r.kind === 'touch');
check('不带 kind 写入的同意仍是敏感信息同意（存量语义不变）', latestSensitive?.granted === false);
check('同意收邮件不会被读成同意处理敏感信息', latestTouch?.granted === true && latestSensitive?.granted === false);
const portraitNoConsent = await post('/api/onboarding/portrait', { locale: 'zh-CN', consent: false }, th.cookie);
check('已同意收邮件、未同意敏感信息 → 画像仍然拒绝生成', portraitNoConsent.status === 400);

await post('/api/me/delete', { confirm: 'DELETE' }, th.cookie);

// ───────────────────── ④ 存量用户零变化（验收 B，最重要）─────────────────────
console.log('\n—— ④ 存量用户零变化：导出只多 books/threads/touch 三个键 ——');
const old = await signUp('legacy');
const OLD_PORTRAIT = {
  spoken: ['M11 存量原话：我总觉得钱会突然没有'],
  baseColor: 'M11 存量底色：钱是安全感本身',
  moments: [{ at: daysAgo(50), text: 'M11 存量瞬间：发工资那天反而更慌' }],
  script: '也许我不配轻松',
  toFuture: 'M11 存量寄语：愿你敢花一次',
  version: 3,
  calibrations: [{ at: daysAgo(40), field: 'script', from: '旧剧本', to: '也许我不配轻松' }],
  scriptStatus: 'confirmed',
  createdAt: daysAgo(60),
};
const OLD_CONFIRMED = {
  actualStage: 1,
  lamps: [
    { kind: 'stage1_story', lit: true, evidence: 'M11 存量依据：故事' },
    { kind: 'stage1_script', lit: true, evidence: 'M11 存量依据：剧本' },
    { kind: 'stage1_color', lit: false, evidence: '' },
  ],
  summary: 'M11 存量总结',
  diagnosis: 'M11 存量诊断',
  distance: 'M11 存量距离',
  actions: ['M11 存量行动'],
  nextHint: '',
  assessedAt: daysAgo(12),
};
const OLD_SEED = {
  locale: 'zh-CN',
  stage: 2,
  concerns: ['money-safety', 'self-worth'],
  pinned: [{ at: daysAgo(30), text: 'M11 存量心印：你不是不配，你是没被允许过' }],
  memories: [{ at: daysAgo(25), text: 'M11 存量记忆：他提到奶奶的铁盒子' }],
  experiments: [{ date: dayStr(6), action: 'M11 存量微行动：把杯子拿出来用', feeling: '松' }],
  letters: [{ at: daysAgo(15), from: 'past', text: 'M11 存量来信：慢一点也可以' }],
  stamps: [
    { kind: 'stage1_story', at: daysAgo(12) },
    { kind: 'stage1_script', at: daysAgo(12) },
    { kind: 'stage2_entered', at: daysAgo(10) },
  ],
  dailySeen: [{ date: dayStr(3), text: 'M11 存量一签：钱不是你的价值' }],
  payday: { type: 'monthly', day: 15 },
  totalActiveDays: 17,
  assessment: { ...emptyState, confirmed: OLD_CONFIRMED, confirmedAt: daysAgo(12) },
};
// 关键：books / threads / touch 一列都不写 —— 这就是 DDL 回填后存量行的样子
await sql`
  INSERT INTO growth_profiles (user_key, locale, portrait, concerns, stage, stage_started_at,
    pinned, memories, experiments, letters, stamps, portrait_evolution, stage_assessment,
    created_at, daily_seen, payday, total_active_days)
  VALUES (${old.key}, 'zh-CN', ${JSON.stringify(OLD_PORTRAIT)}::jsonb, ${JSON.stringify(OLD_SEED.concerns)}::jsonb,
    2, ${daysAgo(10)},
    ${JSON.stringify(OLD_SEED.pinned)}::jsonb, ${JSON.stringify(OLD_SEED.memories)}::jsonb,
    ${JSON.stringify(OLD_SEED.experiments)}::jsonb, ${JSON.stringify(OLD_SEED.letters)}::jsonb,
    ${JSON.stringify(OLD_SEED.stamps)}::jsonb, '{}'::jsonb,
    ${JSON.stringify(OLD_SEED.assessment)}::jsonb, ${daysAgo(60)},
    ${JSON.stringify(OLD_SEED.dailySeen)}::jsonb, ${JSON.stringify(OLD_SEED.payday)}::jsonb, 17)`;
const rawCols = await sql`SELECT books, threads, touch FROM growth_profiles WHERE user_key = ${old.key}`;
check(
  '存量行落库后三列是 DDL 默认值（[] / {} / {}），不是 NULL',
  JSON.stringify(rawCols[0].books) === '[]' &&
    JSON.stringify(rawCols[0].threads) === '{}' &&
    JSON.stringify(rawCols[0].touch) === '{}'
);

const exported = await (await get('/api/me/export', old.cookie)).json();
const p = exported.profile ?? {};

// (1) 键集：M10 的 13 个键一个不少，新增的只有三个
const M10_KEYS = ['locale', 'stage', 'portrait', 'concerns', 'pinned', 'memories', 'experiments', 'letters', 'stamps', 'assessment', 'dailySeen', 'payday', 'totalActiveDays'];
const NEW_KEYS = ['books', 'threads', 'touch'];
const got = Object.keys(p).sort();
const extra = got.filter((k) => !M10_KEYS.includes(k) && !NEW_KEYS.includes(k));
const missing = M10_KEYS.filter((k) => !got.includes(k));
check('导出的 profile 比升级前只多 books / threads / touch 三个键', extra.length === 0 && missing.length === 0, `多=${extra.join(',') || '无'} 少=${missing.join(',') || '无'}`);
check('三个新键都在（加了列不补白名单就导不出来）', NEW_KEYS.every((k) => k in p));

// (2) 逐项一致：画像 / 灯 / 足迹 / 信 / 心印 / 一签 / 其余全部与种子原样
// 注意：JSONB 会按自己的规则重排对象键，比较必须按键排序后再比（否则全是假阴性）
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  }
  return v;
}
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
check('画像原样（原话/底色/瞬间/剧本/校准/版本号）', same(p.portrait, OLD_PORTRAIT), `v=${p.portrait?.version}`);
check('灯原样（确认态评估整对象随行）', same(p.assessment?.confirmed, OLD_CONFIRMED));
check('足迹原样（微行动记录）', same(p.experiments, OLD_SEED.experiments));
check('信原样', same(p.letters, OLD_SEED.letters));
check('心印原样（只增不减，没被多颁也没被吞）', same(p.stamps, OLD_SEED.stamps));
check('一签看过的记录原样', same(p.dailySeen, OLD_SEED.dailySeen));
check(
  '其余字段原样（阶段/语言/在意的事/心印墙/记忆/发薪日/累计天数）',
  p.stage === 2 && p.locale === 'zh-CN' && same(p.concerns, OLD_SEED.concerns) && same(p.pinned, OLD_SEED.pinned) &&
    same(p.memories, OLD_SEED.memories) && same(p.payday, OLD_SEED.payday) && p.totalActiveDays === 17
);

// (3) 三个新键本身是"读时归位"的安全值：一本 v1 书 + 空命题线 + 空触达
check(
  '存量读时自动归位成"在读 v1 这本书"，段数以档案为准（书内进度不出现第二个真源）',
  Array.isArray(p.books) && p.books.length === 1 && p.books[0].bookId === BOOK_ID &&
    p.books[0].status === 'active' && p.books[0].stage === 2,
  JSON.stringify(p.books)
);
check('命题线与触达设置为空（存量没同意过收信，不会被默认打开）', same(p.threads, {}) && same(p.touch, {}));

// (4) 页面这一侧也零变化：灯照旧渲染、一签去重照旧生效
const oldHtml = await (await get('/zh-CN/journey', old.cookie)).text();
check('/journey 照旧渲染（评估卡与灯图在场）', oldHtml.includes('data-lamp') || oldHtml.includes('id="micro-action"'));
const seenAfter = (await sql`SELECT daily_seen FROM growth_profiles WHERE user_key = ${old.key}`)[0].daily_seen ?? [];
check(
  '今日一签照旧发一条并记入去重（不重复种子里看过的那条）',
  seenAfter.length === 2 && seenAfter[0].text === OLD_SEED.dailySeen[0].text && seenAfter[1].text !== OLD_SEED.dailySeen[0].text,
  `n=${seenAfter.length}`
);

const del = await post('/api/me/delete', { confirm: 'DELETE' }, old.cookie);
const leftovers = await sql`
  SELECT (SELECT count(*)::int FROM growth_profiles WHERE user_key = ${old.key}) AS p,
         (SELECT count(*)::int FROM consent_records WHERE user_key = ${old.key}) AS c,
         (SELECT count(*)::int FROM "user" WHERE id = ${old.userId}) AS u`;
check(
  '删除权照旧：三列随行删除（零新表 = 没有漏网的新表）',
  del.status === 200 && Object.values(leftovers[0]).every((n) => n === 0),
  `${del.status} ${JSON.stringify(leftovers[0])}`
);

// ───────────────────── ⑤ 上手路径前置（M11-C）─────────────────────
console.log('\n—— ⑤ 先被说中 → 再同意：问卷交完就给「我听到的是…」——');
const up = await signUp('onboard');
const echoNoAnswers = await post('/api/onboarding/reflect', { locale: 'zh-CN', elapsedMs: 5000 }, up.cookie);
check('还没答问卷 → 不编（400，不许无中生有一句"被说中"）', echoNoAnswers.status === 400, String(echoNoAnswers.status));

const answersRes = await post(
  '/api/onboarding/answers',
  {
    locale: 'zh-CN',
    answers: {
      moment_when: 'cant_remember',
      balance_feeling: 'panic',
      childhood: 'M11 问卷原话：我妈总说咱家不配',
      recent_worry: 'M11 问卷原话：上周看余额突然心慌',
    },
  },
  up.cookie
);
check('问卷落库（第 1 分钟，不要注册、不问同意）', answersRes.status === 200);

const t0 = Date.now();
const echoRes = await post('/api/onboarding/reflect', { locale: 'zh-CN', elapsedMs: 92_000 }, up.cookie);
const echoBody = await echoRes.json().catch(() => ({}));
const echoOk = echoRes.status === 200 && typeof echoBody.summary === 'string' && echoBody.summary.trim().length > 0;
check(
  '不用 sessionId、不用初谈就能拿到那一句（LLM 不可用时 502，前端降级去初谈）',
  echoOk || echoRes.status === 502,
  `${echoRes.status} ${Math.round((Date.now() - t0) / 1000)}s`
);
if (echoOk) {
  check('这一句以「我听到的是」开头（第一个物件）', echoBody.summary.trim().startsWith('我听到的是'), echoBody.summary.slice(0, 24));
  check('素材来源标的是问卷，不是初谈', echoBody.source === 'survey', String(echoBody.source));
}
const echoEvents = await sql`
  SELECT metadata FROM events WHERE user_key = ${up.key} AND name = 'first_echo_shown' ORDER BY id`;
if (echoOk) {
  check('首次"说中了"耗时进埋点', echoEvents.length === 1, `n=${echoEvents.length}`);
  check(
    '埋点只有秒数与来源，没有复述原文（敏感内容不进日志）',
    echoEvents[0]?.metadata?.seconds === 92 &&
      echoEvents[0]?.metadata?.under3min === true &&
      !JSON.stringify(echoEvents[0]?.metadata ?? {}).includes('我听到的是'),
    JSON.stringify(echoEvents[0]?.metadata ?? {})
  );
  const again = await post('/api/onboarding/reflect', { locale: 'zh-CN', elapsedMs: 999_000 }, up.cookie);
  const againEvents = await sql`
    SELECT count(*)::int AS n FROM events WHERE user_key = ${up.key} AND name = 'first_echo_shown'`;
  check('"首次"就是首次：再来一次不覆盖也不重复记', again.status !== 500 && againEvents[0].n === 1);
}
const consentBefore = await sql`SELECT count(*)::int AS n FROM consent_records WHERE user_key = ${up.key}`;
check('被说中之前一次同意都没要过（顺序铁律：先被说中 → 再注册/同意/定价）', consentBefore[0].n === 0);

const wizardHtml = await (await get('/zh-CN/onboarding', up.cookie)).text();
check('体检页从问卷开始（同意区不在首屏）', !wizardHtml.includes('data-consent'));

await post('/api/me/delete', { confirm: 'DELETE' }, up.cookie);

// ⑥ 日频形态与「你走过的路」（M11-D，docs/05 §3.1/§3.2/§3.5/§8）
// 这一段验的是形态，不是文案：日常页是「一段」不是三件事、四段是区域不是进度条、
// 灯图带命题维度、书只在 /road 露面。全部走 data-* 锚点——dict 会被整份序列化进
// RSC flight payload，「某句话不出现」级别的断言在这里一律不可靠。
console.log('\n—— ⑥ 日频形态与你走过的路（M11-D）——');
const rd = await signUp('road');
const Q_SELF = 'M11-D 原话：我一直觉得自己不配拿这份钱。';
const Q_PARENT = 'M11-D 原话：我妈那句话我记了二十年。';
const RD_THREADS = {
  'self-worth': {
    depth: 'mastered',
    firstSeenAt: daysAgo(30),
    lastSeenAt: daysAgo(2),
    evidence: [
      { at: daysAgo(30), bookId: BOOK_ID, source: 'assessment', ref: 'stage1_script', quote: Q_SELF },
    ],
  },
  parents: {
    depth: 'seen',
    firstSeenAt: daysAgo(20),
    lastSeenAt: daysAgo(20),
    evidence: [{ at: daysAgo(20), bookId: BOOK_ID, source: 'assessment', ref: 'stage1_story', quote: Q_PARENT }],
  },
  'inner-turmoil': {
    depth: 'replaced',
    firstSeenAt: daysAgo(15),
    lastSeenAt: daysAgo(5),
    evidence: [{ at: daysAgo(15), bookId: BOOK_ID, source: 'stamp', ref: 'stage1_color', quote: '' }],
  },
};
const RD_CONFIRMED = {
  actualStage: 2,
  lamps: [
    { kind: 'stage2_claim', lit: false, evidence: '' },
    { kind: 'stage2_try', lit: false, evidence: '' },
    { kind: 'stage2_voice', lit: false, evidence: '' },
  ],
  summary: 'M11-D 总结：你刚走进第二段。',
  diagnosis: 'M11-D 诊断：还在看，还没动手。',
  distance: 'M11-D 距离：差一次真的开口。',
  actions: ['M11-D 行动：跟一个人说出你的价。'],
  nextHint: '',
  assessedAt: daysAgo(1),
};
await sql`
  INSERT INTO growth_profiles (user_key, locale, portrait, concerns, stage, stage_started_at,
    pinned, memories, experiments, letters, stamps, portrait_evolution, stage_assessment,
    created_at, daily_seen, threads)
  VALUES (${rd.key}, 'zh-CN', ${JSON.stringify(portrait)}::jsonb, '[]'::jsonb, 2, ${daysAgo(10)},
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
    ${JSON.stringify({ ...emptyState, confirmed: RD_CONFIRMED, confirmedAt: daysAgo(1) })}::jsonb,
    ${daysAgo(30)}, '[]'::jsonb, ${JSON.stringify(RD_THREADS)}::jsonb)`;

const jHtml = await get('/zh-CN/journey', rd.cookie).then((r) => r.text());
const arcSteps = (jHtml.match(/data-arc-step="(open|do|close)"/g) ?? []).map((m) => m.slice(15, -1));
check(
  '日常页是「一段」不是三件事：开 → 做 → 合 一个容器里走完',
  (jHtml.match(/data-day-arc/g) ?? []).length >= 1 && arcSteps.join(',') === 'open,do,close',
  arcSteps.join(',') || '(无)'
);
check('这一段有明确收束：「今天到这里」在场（不留悬着的尾巴）', jHtml.includes('data-day-close'));
// 书名只出现在 /road；日常页连书名都不该有（docs/05 §3.5 唯一露出点）
const BOOK_TITLE_ZH = '一生不为钱发愁的活法';
check(
  '日常页不出现书：整页一次书名都没有（书只在「你走过的路」露面）',
  !jHtml.includes(BOOK_TITLE_ZH)
);
check('日常页给出了去「你走过的路」的入口', jHtml.includes(`href="/zh-CN/road"`));

// 区域视图：走过的区域整段亮、当前区域按评估亮、还没走到的不计数
const rdZone = (n) => {
  const i = jHtml.indexOf(`data-segment="${n}"`);
  if (i < 0) return '';
  const next = jHtml.indexOf('data-segment=', i + 1); // 切到下一段为止，别把隔壁的灯数进来
  return jHtml.slice(i, next === -1 ? i + 2000 : next);
};
const rdLamps = (n) => (rdZone(n).match(/data-zone-lamp="(\d)"/g) ?? []).map((m) => m.slice(-2, -1)).join('');
check(
  '四段是四个区域：走过 / 当前 / 还没走到 三种状态各就各位',
  rdZone(1).includes('data-zone-state="walked"') &&
    rdZone(2).includes('data-zone-state="current"') &&
    rdZone(3).includes('data-zone-state="ahead"') &&
    rdZone(4).includes('data-zone-state="ahead"'),
  [1, 2, 3, 4].map((n) => (rdZone(n).match(/data-zone-state="(\w+)"/) ?? [, '?'])[1]).join('/')
);
check(
  '区域不是百分比进度条：灯只有亮/不亮，没有填充宽度',
  rdLamps(1) === '111' && rdLamps(2) === '000' && !/data-segment="\d"[^>]*width:/.test(jHtml),
  `z1=${rdLamps(1)} z2=${rdLamps(2)}`
);

// 命题灯图：每盏灯挂在哪条命题线上 + 这条线跨书走到哪了
const lampTopics = (jHtml.match(/data-lamp-topic="([a-z-]+)"/g) ?? []).map((m) => m.slice(17, -1));
check(
  '灯图带命题维度：当前阶段每盏灯都标出它落在哪条命题线上',
  lampTopics.length === 3 && lampTopics.every((t) => TOPICS.includes(t)),
  lampTopics.join(',')
);
check(
  '灯没亮，但这条命题线上跨书攒下的程度照样标出来（换书不退）',
  jHtml.includes('data-thread-depth="mastered"'),
  (jHtml.match(/data-thread-depth="(\w+)"/) ?? [, '(无)'])[1]
);

// 「你走过的路」：书唯一露出点，且只当出处与邀请
const rHtml = await get('/zh-CN/road', rd.cookie).then((r) => r.text());
const roadLines = (rHtml.match(/data-road-line="([a-z-]+)"/g) ?? []).map((m) => m.slice(16, -1));
const roadAhead = (rHtml.match(/data-road-ahead="([a-z-]+)"/g) ?? []).map((m) => m.slice(17, -1));
check(
  '走过的路 = 被点到过的命题线，按最近走到的排前面',
  roadLines.join(',') === 'self-worth,inner-turmoil,parents',
  roadLines.join(',')
);
check(
  '还没走到的命题单列一区，不混进「走过的路」当欠账',
  roadAhead.length === 3 && roadAhead.every((t) => TOPICS.includes(t) && !roadLines.includes(t)),
  roadAhead.join(',')
);
check(
  '陈列的是他自己的原话，不是结论（空原话不占位）',
  rHtml.includes(Q_SELF) && rHtml.includes(Q_PARENT),
  `self=${rHtml.includes(Q_SELF)} parents=${rHtml.includes(Q_PARENT)}`
);
check(
  '书在这里只当出处：命题线标了它是在哪本书里被点到的',
  rHtml.includes('data-road-source') && rHtml.includes(BOOK_TITLE_ZH)
);
check(
  '打开过的书列在这里（书唯一的露出点）',
  rHtml.includes(`data-road-book="${BOOK_ID}"`)
);
check(
  '只有一本书时不推销：走完的命题线上也不冒出「下一本」邀请',
  !rHtml.includes('data-road-invite')
);
const rdDepth = (rHtml.match(/data-road-depth="(\w+)"/g) ?? []).map((m) => m.slice(17, -1));
check(
  '程度是程度，不是分数：seen / replaced / mastered 原样标出',
  rdDepth.join(',') === 'mastered,replaced,seen',
  rdDepth.join(',')
);


// ⑦ 触达层合规（M11-E，docs/05 §9.3 三条硬约束 + §10 验收 D）
// 这一段一封信都不真发：Resend 没配时 dispatch 自动降级成试算，正好把"该发谁"
// 算清楚又不打扰任何人。真正要守住的是"谁收不到"：没同意的、人还在的、发过的、
// 退订了的——四种人一个都不许出现在命中名单里。
console.log('\n—— ⑦ 触达层合规（M11-E）——');
const CRON = process.env.TOUCH_CRON_SECRET;
const dispatch = (body = {}, secret = CRON) =>
  fetch(BASE + '/api/touch/dispatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-touch-secret': secret ?? '' },
    body: JSON.stringify({ dryRun: true, ...body }),
  });

const tu = await signUp('touch');
await sql`
  INSERT INTO growth_profiles (user_key, locale, portrait, concerns, stage, stage_started_at,
    pinned, memories, experiments, letters, stamps, portrait_evolution, stage_assessment,
    created_at, daily_seen, last_active_date)
  VALUES (${tu.key}, 'zh-CN', ${JSON.stringify(portrait)}::jsonb, '[]'::jsonb, 1, ${daysAgo(40)},
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
    ${JSON.stringify([{ stage: 1, content: 'M11-E 原话：我不敢报那个价。', state: 'kept', aiReply: null, createdAt: daysAgo(35) }])}::jsonb,
    '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, ${daysAgo(40)}, '[]'::jsonb, ${dayStr(12)}::date)`;

const nPlanned = (r) => (r.byNode ? Object.values(r.byNode).reduce((a, b) => a + b, 0) : 0);
// 扫描是全库的，别的用户也可能在名单里 —— 所以一律看**增量**：
// 只关心"我们这个测试用户有没有被算进去"，不关心库里本来有几个人该收信。
const scan = async () => {
  const r = await dispatch().then((x) => x.json());
  return { r, n: nPlanned(r) };
};

if (!CRON) {
  check('调度端点没配 secret → 直接关门（不开一个谁都能打的发信端点）', (await dispatch({}, 'x')).status === 503);
} else {
  check('错口令打不开调度端点', (await dispatch({}, 'wrong-secret')).status === 403);

  // D-1：未 opt-in 收不到任何触达邮件
  const base = await scan();
  const touchBefore = (await sql`SELECT touch FROM growth_profiles WHERE user_key = ${tu.key}`)[0].touch ?? {};
  check('没同意收信的人：touch 里空空如也，候选名单都进不去（合规第一条）',
    Object.keys(touchBefore).length === 0, JSON.stringify(touchBefore));

  const optIn = await post('/api/touch/consent', { optIn: true }, tu.cookie);
  check('打开来信：opt-in 落库', optIn.status === 200);
  const touchRow = (await sql`SELECT touch FROM growth_profiles WHERE user_key = ${tu.key}`)[0].touch ?? {};
  check('生成了退订凭据（没有凭据的信不许发出去）', Boolean(touchRow.unsubToken) && touchRow.emailOptIn === true);
  const tKinds = await sql`SELECT kind, granted FROM consent_records WHERE user_key = ${tu.key} ORDER BY id`;
  check(
    '触达同意记成 kind=touch，没污染敏感信息同意（两件事分开记）',
    tKinds.length === 1 && tKinds[0].kind === 'touch' && tKinds[0].granted === true,
    tKinds.map((k) => `${k.kind}:${k.granted}`).join(',')
  );

  // D-2：到了节点才发，且只发该发的那一封
  const after = await scan();
  check('同意之后、到了节点：命中该发的那一封（且只多出一封）', after.n === base.n + 1, `${base.n} → ${after.n}`);
  const node = Object.keys(after.r.byNode ?? {}).find((k) => (after.r.byNode[k] ?? 0) > (base.r.byNode?.[k] ?? 0));
  check('建档 40 天、12 天没来 → 命中 D30（节点取"已到期里最大的那个"）', node === 'D30', String(node));
  check('试算不占位：sentNodes 还是空的（没发就不许记成发过）',
    Object.keys((await sql`SELECT touch FROM growth_profiles WHERE user_key = ${tu.key}`)[0].touch?.sentNodes ?? {}).length === 0);
  check('Resend 没配 → 自动降级成试算，不报错也不假装发了', after.r.configured === false && after.r.dryRun === true);

  // 人还在这儿的时候不召回（邮件是节点召回，不是日活引擎）
  await sql`UPDATE growth_profiles SET last_active_date = now()::date WHERE user_key = ${tu.key}`;
  const present = await scan();
  check('人今天还来过 → 不发（这不是日活引擎）', present.n === base.n, `${base.n} vs ${present.n}`);
  await sql`UPDATE growth_profiles SET last_active_date = ${dayStr(12)}::date WHERE user_key = ${tu.key}`;

  // 每个节点只发一次：占位过就不再命中（重发防护不靠"脚本别重复跑"）
  await sql`
    UPDATE growth_profiles
    SET touch = touch || jsonb_build_object('sentNodes', jsonb_build_object('D30', ${daysAgo(1)}::text))
    WHERE user_key = ${tu.key}`;
  const resent = await scan();
  check('D30 发过就不再发：同一封信一辈子只发一次', resent.n === base.n, `${base.n} vs ${resent.n}`);
  await sql`UPDATE growth_profiles SET touch = touch - 'sentNodes', last_active_date = ${dayStr(12)}::date WHERE user_key = ${tu.key}`;

  // D-2：退订链接生效且 events 有记录
  const token = touchRow.unsubToken;
  const unsub = await fetch(`${BASE}/api/touch/unsubscribe?token=${encodeURIComponent(token)}&locale=zh-CN`, { redirect: 'manual' });
  check('退订链接一点就成（不要求先登录）', unsub.status === 307 || unsub.status === 302, `status=${unsub.status}`);
  const afterUnsub = (await sql`SELECT touch FROM growth_profiles WHERE user_key = ${tu.key}`)[0].touch ?? {};
  check('退订后来信关闭', afterUnsub.emailOptIn === false);
  check('但退订凭据留着：已发出去那几封信的退订链接不能跟着失效', afterUnsub.unsubToken === token);
  const ev = await sql`SELECT count(*)::int AS n FROM events WHERE user_key = ${tu.key} AND name = 'touch_opt_out'`;
  check('退订有据可查（events 留痕）', ev[0].n >= 1, `n=${ev[0].n}`);
  const lastConsent = await sql`SELECT kind, granted FROM consent_records WHERE user_key = ${tu.key} ORDER BY id DESC LIMIT 1`;
  check('退订也记进同意链（kind=touch, granted=false）',
    lastConsent[0].kind === 'touch' && lastConsent[0].granted === false);
  const gone = await scan();
  check('退订之后：一封都不再发', gone.n === base.n, `${base.n} vs ${gone.n}`);

  const badTok = await fetch(`${BASE}/api/touch/unsubscribe?token=&locale=zh-CN`, { redirect: 'manual' });
  const badLoc = badTok.headers.get('location') ?? '';
  check('空 token 不会误退订别人（落地页给失败态）', badLoc.includes('ok=0'), badLoc.slice(-24));
}

// D-3/D-4：导出含 touch；游客期的 touch 跟着账号走；删除后随行清空
const gid = crypto.randomUUID().replace(/-/g, '');
const guestCookie = `guest_qk=${gid}`;
await post('/api/journal', { content: 'M11-E 游客期的一篇心事', locale: 'zh-CN' }, guestCookie);
await sql`UPDATE growth_profiles SET touch = jsonb_build_object('emailOptIn', true, 'unsubToken', 'guest-tok-m11e') WHERE user_key = ${`g:${gid}`}`;
const gu = await signUp('merge');
await get('/api/journal', `${gu.cookie}; ${guestCookie}`); // 登录态 + 游客 cookie 并存 → 顺手迁移
const merged = (await sql`SELECT touch FROM growth_profiles WHERE user_key = ${gu.key}`)[0]?.touch ?? {};
check(
  '游客期打开的来信设置，登录后跟着账号走（验收 D-4）',
  merged.emailOptIn === true && merged.unsubToken === 'guest-tok-m11e',
  JSON.stringify(merged)
);

const exp = await get('/api/me/export', tu.cookie).then((r) => r.json());
check('导出含 touch（用户能看到自己的来信设置）', 'touch' in (exp.profile ?? {}), Object.keys(exp.profile ?? {}).includes('touch') ? 'ok' : JSON.stringify(Object.keys(exp.profile ?? {})));
const delRes = await post('/api/me/delete', { confirm: 'DELETE' }, tu.cookie);
const leftover = await sql`
  SELECT (SELECT count(*)::int FROM growth_profiles WHERE user_key = ${tu.key}) AS p,
         (SELECT count(*)::int FROM consent_records WHERE user_key = ${tu.key}) AS c,
         (SELECT count(*)::int FROM events WHERE user_key = ${tu.key}) AS e,
         (SELECT count(*)::int FROM "user" WHERE id = ${tu.userId}) AS u`;
check('删除账号 → 来信设置与同意链一起清空（零新表 = 没有漏网的行）',
  delRes.status === 200 && leftover[0].p === 0 && leftover[0].c === 0 && leftover[0].e === 0 && leftover[0].u === 0,
  JSON.stringify(leftover[0]));
await post('/api/me/delete', { confirm: 'DELETE' }, gu.cookie);


console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 处失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
