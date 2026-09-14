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

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 处失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
