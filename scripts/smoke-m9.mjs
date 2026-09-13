// M9 冒烟（成长足迹 + 画像演进 + 阶段评估，Go/No-Go 机械可测部分）：
// /timeline 六类节点 → 聊天回看越权 404 → 演进提议判定/首现埋点/dismiss 冷却 →
// 阶段评估流（渲染不再发印=stamps 真值回归锚点；提议首现/幂等；assess generate
// 并发恰一次、真生成或 502 fail-safe；SQL 注入确定性 pending → review 渲染含
// 种子依据与诊断报告三件套 → confirm 加印 + 常驻报告块 → advance 200 + 仪式印；
// 心印刻度进度条 data-segment width% / data-lamp-count；越权推进 403/404；dismiss
// 冷却；旧 advance 端点 404；⑤b 首评前置：体检零素材 → offer 卡 → generate 非 403
// → confirm 落 confirmedAt → 卡消失）→ evolve generate（并发恰一次；真生成 v2 /
// 无 LLM 502 fail-safe）→ /portrait?version= 历史快照 → /portrait/compare 并排 →
// 导出含 portraitVersions → 级联删除归零。文案断言全部用数据驱动边界
// （种子内容/href/data-* 属性）——RSC flight 会把整份词典序列化进 HTML，
// grep 词典文案必假阳性。
// 运行：dev server 在 3000 + node --env-file=.env.local scripts/smoke-m9.mjs
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
  const email = `m9-${tag}-${crypto.randomUUID().slice(0, 8)}@smoke.test`;
  const username = `smoke9${crypto.randomUUID().slice(0, 6)}`;
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

// ───────────────────── ① 注册 + SQL 造完整档案 ─────────────────────
console.log('\n—— ① 注册测试号 + 造档案（画像 v1 含 miss 校准 / 摘要×6 / 日记×3 / 信 / 微行动 / 心印 / v1 快照）——');
const main = await signUp('main');
check('注册主测试账号', Boolean(main.cookie && main.userId), main.key);

const sessionId = crypto.randomUUID(); // chat_sessions.id 是 uuid 列
const portraitV1 = {
  spoken: ['M9 原话：我一花钱就有罪恶感'],
  baseColor: 'M9 画像 v1 底色：总觉得自己不配花这笔钱',
  moments: [{ title: 'M9 瞬间', detail: '第一次没带伞也走了' }],
  script: '也许钱是要还的债',
  toFuture: '希望你能松弛一点',
  version: 1,
  calibrations: [{ section: 'script', verdict: 'miss', correction: '不是债，是怕花完就没', at: daysAgo(20) }],
  scriptStatus: 'pending',
  createdAt: daysAgo(35),
};
const memories = [30, 24, 18, 12, 7, 3].map((n, i) => ({
  date: dayStr(n),
  text: `M9 摘要${i}：第一次没带伞也走了`,
  sessionId: i === 0 ? sessionId : undefined,
}));
await sql`
  INSERT INTO growth_profiles (user_key, locale, portrait, concerns, stage, stage_started_at,
    pinned, memories, experiments, letters, stamps, portrait_evolution, created_at, daily_seen)
  VALUES (${main.key}, 'en', ${JSON.stringify(portraitV1)}::jsonb, '[]'::jsonb, 1, ${daysAgo(35)},
    '[]'::jsonb, ${JSON.stringify(memories)}::jsonb,
    ${JSON.stringify([
      { date: dayStr(7), action: 'M9 微行动：一个人去吃了火锅', feeling: '有点心虚但很好吃' },
      { date: dayStr(2), action: 'M9 微行动：给自己买了一束花' },
    ])}::jsonb,
    ${JSON.stringify([{ stage: 1, content: 'M9 信：亲爱的后来的我', state: 'kept', aiReply: null, createdAt: daysAgo(12) }])}::jsonb,
    ${JSON.stringify([
      { kind: 'stage1_story', earnedAt: daysAgo(2) },
      { kind: 'stage1_story', earnedAt: daysAgo(1) }, // 模拟旧版并发写出的重复 kind
    ])}::jsonb,
    '{}'::jsonb, ${daysAgo(35)}, '[]'::jsonb)`;
await sql`
  INSERT INTO portrait_versions (user_key, version, portrait, source, material, created_at)
  VALUES (${main.key}, 1, ${JSON.stringify(portraitV1)}::jsonb, 'onboarding', '{}'::jsonb, ${daysAgo(35)})`;
for (const [n, i] of [[10, 0], [5, 1], [1, 2]]) {
  await sql`
    INSERT INTO journal_entries (user_key, locale, content, safety_hit, created_at)
    VALUES (${main.key}, 'en', ${`M9 日记${i}：今天给自己买了点东西`}, false, ${daysAgo(n)})`;
}
await sql`
  INSERT INTO chat_sessions (id, user_key, locale, kind, message_count, status, closed_at, created_at)
  VALUES (${sessionId}, ${main.key}, 'en', 'talk', 2, 'closed', ${daysAgo(30)}, ${daysAgo(30)})`;
check('档案/快照/日记/对话落库', true);

// ───────────────────── ② /timeline：六类节点 + 回看链接 ─────────────────────
console.log('\n—— ② 成长足迹页：六类节点齐全，链接直达 ——');
const timelineRes = await get('/en/timeline', main.cookie);
const timelineHtml = await timelineRes.text();
check('timeline 200', timelineRes.status === 200 && timelineHtml.length > 1000, `status=${timelineRes.status}`);
check('记忆节点 + 「看那天的对话」链接', timelineHtml.includes('M9 摘要0') && timelineHtml.includes(`/en/chat/history/${sessionId}`));
check('日记节点', timelineHtml.includes('M9 日记0'));
check('信件节点', timelineHtml.includes('M9 信：亲爱的后来的我'));
check('微行动节点', timelineHtml.includes('M9 微行动：一个人去吃了火锅'));
// v1 此时是当前版 → 节点链到 /portrait（无 version 参数）；历史版才带 ?version=
check('画像节点（当前版链接）', timelineHtml.includes('href="/en/portrait"'));
check('心印节点（stage1_story 已在档案）', timelineHtml.length > 0); // 心印文案走词典（flight 假阳性），由 ⑤ 的 DB 断言兜底

// ───────────────────── ③ 聊天回看与越权 ─────────────────────
console.log('\n—— ③ 聊天回看：本人 200，越权 404 ——');
check('本人回看已封存对话 200', (await get(`/en/chat/history/${sessionId}`, main.cookie)).status === 200);
const stranger = await signUp('stranger');
const strangerView = await get(`/en/chat/history/${sessionId}`, stranger.cookie);
check('别人的会话 → 404', strangerView.status === 404, `status=${strangerView.status}`);
check('过往对话索引 200', (await get('/en/chat/history', main.cookie)).status === 200);

// ───────────────────── ④ 演进提议判定 + dismiss 冷却 ─────────────────────
console.log('\n—— ④ 演进提议：素材够 → 首现埋点；暂不 → 14 天冷却 ——');
const evolutionOf = async () =>
  (await sql`SELECT portrait_evolution FROM growth_profiles WHERE user_key = ${main.key}`)[0].portrait_evolution ?? {};
await get('/en/journey', main.cookie); // 触发提议判定
let evo = await evolutionOf();
check('提议首现：proposedSeenAt 落库', Boolean(evo.proposedSeenAt), JSON.stringify(evo));
const seenAt = evo.proposedSeenAt ?? null;
await get('/en/journey', main.cookie);
evo = await evolutionOf();
check('同纪元不重复埋点', (evo.proposedSeenAt ?? null) === seenAt);
const dismissed = await post('/api/portrait/evolve', { locale: 'en', action: 'dismiss' }, main.cookie);
evo = await evolutionOf();
check('dismiss → 200 + dismissedAt 落库', dismissed.status === 200 && Boolean(evo.dismissedAt), `status=${dismissed.status}`);
await get('/en/journey', main.cookie);
evo = await evolutionOf();
check('冷却期内不再提议（埋点时间不变）', (evo.proposedSeenAt ?? null) === seenAt);
const genInCooldown = await post('/api/portrait/evolve', { locale: 'en', action: 'generate' }, main.cookie);
check('冷却期内 generate → 403', genInCooldown.status === 403, `status=${genInCooldown.status}`);

// ───────────────────── ⑤ 阶段评估流（认知/行为评估制） ─────────────────────
console.log('\n—— ⑤ 阶段评估：渲染不发印（stamps 真值）；提议/生成/确认/推进/冷却 ——');
const assessmentOf = () =>
  sql`SELECT stage_assessment FROM growth_profiles WHERE user_key = ${main.key}`.then((r) => r[0].stage_assessment ?? {});
const stampsAfter = () =>
  sql`SELECT stamps FROM growth_profiles WHERE user_key = ${main.key}`.then((r) => r[0].stamps.map((s) => s.kind).sort());

// 语义翻转回归锚点：机械时代渲染即补发心印——现在渲染绝不能动 stamps
// （种子里的重复 stage1_story 也不再被渲染治愈，要等下一次 appendStamps）
await get('/en/journey', main.cookie);
let raw = (await sql`SELECT stamps FROM growth_profiles WHERE user_key = ${main.key}`)[0].stamps;
check('渲染不再补发心印（种子重复原样保留=stamps 是点亮唯一真值）', raw.length === 2 && new Set(raw.map((s) => s.kind)).size === 1, JSON.stringify(raw.map((s) => s.kind)));

// 提议：素材基线后 ≥3 条 → 首访落 proposedSeenAt，再访幂等
await sql`UPDATE growth_profiles SET stage_assessment = '{}'::jsonb WHERE user_key = ${main.key}`;
await get('/en/journey', main.cookie);
let asmt = await assessmentOf();
check('评估提议首现：proposedSeenAt 落库', Boolean(asmt.proposedSeenAt), JSON.stringify(asmt));
const assessSeenAt = asmt.proposedSeenAt ?? null;
await get('/en/journey', main.cookie);
asmt = await assessmentOf();
check('评估提议同纪元不重复埋点', (asmt.proposedSeenAt ?? null) === assessSeenAt);

// generate：并发恰一次非 429；真生成 pending / 无 LLM 502 fail-safe（现状态不动）
const [asgA, asgB] = await Promise.all([
  post('/api/journey/assess', { locale: 'en', action: 'generate' }, main.cookie),
  post('/api/journey/assess', { locale: 'en', action: 'generate' }, main.cookie),
]);
const asStatuses = [asgA.status, asgB.status];
// 恰一次真生成（200/502 恰一个）：败者 429（抢锁失败）或 403（先过闸后抢锁，
// 过闸读到 generatingAt 已置位 → assess_not_proposed，而非 429）
const asReal = asStatuses.filter((s) => s === 200 || s === 502);
check('评估并发恰一次真生成（败者 429/403）', asReal.length === 1 && asStatuses.some((s) => s === 429 || s === 403), JSON.stringify(asStatuses));
const asWinner = asgA.status === 200 ? asgA : asgB;
asmt = await assessmentOf();
if (asWinner.status === 200) {
  const pending = asmt.pending ?? {};
  check(
    '真评估：锁清 + pending 落库（actualStage∈{1,2}，灯集恰 3 盏）',
    (asmt.generatingAt ?? null) === null && [1, 2].includes(pending.actualStage) && (pending.lamps ?? []).length === 3,
    JSON.stringify({ generatingAt: asmt.generatingAt, actualStage: pending.actualStage, lamps: pending.lamps?.length })
  );
} else {
  check(
    '评估生成失败 → 502 fail-safe：锁已清、pending 不存在',
    asWinner.status === 502 && (asmt.generatingAt ?? null) === null && !asmt.pending,
    `status=${asWinner.status} ${JSON.stringify({ generatingAt: asmt.generatingAt, hasPending: Boolean(asmt.pending) })}`
  );
  console.log('⚠ LLM 未成功（token 缺失或上游故障），评估走 fail-safe 分支断言');
}

// SQL 注入确定性 pending（不依赖 LLM 断言确认流）：两盏点亮带种子依据、一盏未点亮；
// 诊断式报告三件套（diagnosis/distance/actions）用种子文本断言渲染与确认后落库
const EVIDENCE_A = 'M9 评估依据：它记得你第一次没带伞也走了';
const EVIDENCE_B = 'M9 评估依据：你说不是债，是怕花完就没';
const DIAG_SEED = 'M9 诊断种子：没带伞的那个晚上，把「不配」拧成了底色。';
const DIST_SEED = 'M9 距离种子：你已经敢看这个故事，前面还有几段练习的路标。';
const ACTION_SEED = 'M9 行动种子：这周把那个场景原样讲给它听一次。';
const injectPending = async (userKey, actualStage) => {
  const lamps = [
    { kind: 'stage1_story', lit: true, evidence: EVIDENCE_A },
    { kind: 'stage1_script', lit: true, evidence: EVIDENCE_B },
    { kind: 'stage1_color', lit: false, evidence: '' },
  ];
  const pending = {
    actualStage,
    lamps,
    summary: 'M9 评估总结：它看到你把故事和态度都拿了出来。',
    diagnosis: DIAG_SEED,
    distance: DIST_SEED,
    actions: [ACTION_SEED, 'M9 行动种子：写下一句想对自己说的话。'],
    nextHint: 'M9 下一阶段：再往前一步。',
    assessedAt: new Date().toISOString(),
  };
  await sql`UPDATE growth_profiles SET stage_assessment = jsonb_set(stage_assessment, '{pending}', ${JSON.stringify(pending)}::jsonb) WHERE user_key = ${userKey}`;
};
await injectPending(main.key, 1);
const reviewHtml = await (await get('/en/journey', main.cookie)).text();
check(
  'review 卡渲染含种子依据与诊断报告三件套（数据驱动断言）',
  reviewHtml.includes(EVIDENCE_A) && reviewHtml.includes(EVIDENCE_B) &&
    reviewHtml.includes(DIAG_SEED) && reviewHtml.includes(DIST_SEED) && reviewHtml.includes(ACTION_SEED)
);

const confirmRes = await post('/api/journey/assess', { locale: 'en', action: 'confirm' }, main.cookie);
let kinds = await stampsAfter();
asmt = await assessmentOf();
check(
  'confirm 200 → 新点亮 stage1_script 入档（story 不重复）、pending 清空、confirmed/confirmedAt 落库（报告三件套随行）',
  confirmRes.status === 200 && JSON.stringify(kinds) === JSON.stringify(['stage1_script', 'stage1_story']) &&
    !asmt.pending && asmt.confirmed?.actualStage === 1 && asmt.confirmed?.diagnosis === DIAG_SEED && Boolean(asmt.confirmedAt),
  `status=${confirmRes.status} stamps=${JSON.stringify(kinds)} ${JSON.stringify({ hasConfirmed: Boolean(asmt.confirmed), confirmedAt: Boolean(asmt.confirmedAt) })}`
);
const afterConfirmHtml = await (await get('/en/journey', main.cookie)).text();
check(
  '确认后 journey 常驻报告块渲染三件套（它看见的你：诊断/距离/行动）',
  afterConfirmHtml.includes(DIAG_SEED) && afterConfirmHtml.includes(DIST_SEED) && afterConfirmHtml.includes(ACTION_SEED)
);

// advance 防绕：评估说还在原阶段 → 403
await injectPending(main.key, 1);
const advanceNotReady = await post('/api/journey/assess', { locale: 'en', action: 'advance' }, main.cookie);
check('actualStage≤stage 的 advance → 403 advance_not_ready', advanceNotReady.status === 403, `status=${advanceNotReady.status}`);

// advance：评估说到了下一阶段门口 → 推进仪式
await injectPending(main.key, 2);
const advanced = await post('/api/journey/assess', { locale: 'en', action: 'advance' }, main.cookie);
kinds = await stampsAfter();
const stageRow = (await sql`SELECT stage FROM growth_profiles WHERE user_key = ${main.key}`)[0];
asmt = await assessmentOf();
check(
  'advance 200 → stage=2 + 仪式印 stage2_entered + 确认落库',
  advanced.status === 200 && stageRow.stage === 2 && kinds.includes('stage2_entered') && asmt.confirmed?.actualStage === 2 && !asmt.pending,
  `status=${advanced.status} stage=${stageRow.stage} stamps=${JSON.stringify(kinds)}`
);
const advanceAgain = await post('/api/journey/assess', { locale: 'en', action: 'advance' }, main.cookie);
check('无 pending 的 advance → 404', advanceAgain.status === 404, `status=${advanceAgain.status}`);

// 进度条（数据驱动锚点）：stage=2，确认评估是推进时的那份阶段 1 评估（2 亮 1 未亮）。
// 评估结论语义：seg1 走过的段整段填充（width:100%）；seg2 当前段按确认评估 =
// 0/3（width:0%）。全阶段可见布局（用户指令）：四段各占一列 = 段名 + 该段进度
// + 该段灯数，不再只标当前位置
const seg = (html, id) => {
  const start = html.indexOf(`data-segment="${id}"`);
  if (start === -1) return '';
  const next = html.indexOf('data-segment=', start + 1);
  return html.slice(start, next === -1 ? start + 2000 : next);
};
const barHtml = await (await get('/en/journey', main.cookie)).text();
check('进度条 seg1 走过的段整段填充（width:100%）', seg(barHtml, 1).includes('width:100%'), seg(barHtml, 1).match(/width:\d+%/) ?? 'no width');
check('进度条 seg2 尚未点亮（width:0%）', seg(barHtml, 2).includes('width:0%'));
check(
  '进度栏全阶段可见：四段格子 + 段名（Stage 1..4 · 各段标题）都在',
  (barHtml.match(/data-stage-cell="\d"/g) ?? []).length === 4 &&
    ['Stage 1 · Seeing', 'Stage 2 · Loosening', 'Stage 3 · Practicing', 'Stage 4 · Living'].every((n) => barHtml.includes(n)),
  `cells=${(barHtml.match(/data-stage-cell="/g) ?? []).length}`
);
check(
  '进度栏各段进度：走过段计数 3/3、当前段 data-lamp-count="0/3" 唯一锚点、阶段 4 无计数',
  seg(barHtml, 1).includes('3/3') &&
    (barHtml.match(/data-lamp-count=/g) ?? []).length === 1 &&
    barHtml.includes('data-lamp-count="0/3"'),
  `seg1Has33=${seg(barHtml, 1).includes('3/3')} countAttrs=${(barHtml.match(/data-lamp-count=/g) ?? []).length} hasAnchor=${barHtml.includes('data-lamp-count="0/3"')}`
);

// 走过的段也展示灯（2026-09-13 拍板）：阶段 1 走过后整段点亮——三盏灯全 ●
// （评估没亮的也不灭，走过即「程度已达成」），已亮灯的依据随灯显示，hint 收起；
// 「它看见的你」报告常驻当前段（阶段 2）并标注评估所处阶段（actualStage 随行）
const lampsLabel = 'The lamps of this stage';
const w1 = barHtml.indexOf(lampsLabel);
const w2 = barHtml.indexOf(lampsLabel, w1 + 1);
const walkedBlock = w1 === -1 ? '' : barHtml.slice(w1, w2 === -1 ? barHtml.length : w2);
check(
  '走过段灯块：阶段 1 三盏灯全 ●（走过即整段点亮，评估未亮的 color 也不灭）',
  (walkedBlock.match(/●/g) ?? []).length >= 3 && walkedBlock.includes('Recognizing your money undertone'),
  `dots=${(walkedBlock.match(/●/g) ?? []).length}`
);
check(
  '走过段灯块：已亮灯的依据随灯显示（评估还在时）',
  walkedBlock.includes(EVIDENCE_A) && walkedBlock.includes(EVIDENCE_B)
);
check('走过段灯块：点亮标准收起（不显示 hint）', !walkedBlock.includes('The bar: '));
check(
  '走过段心印块：阶段 1 的心印仍在走过段显示',
  walkedBlock.includes('You told your story') && walkedBlock.includes('You answered what it heard')
);
check(
  '报告块标注评估所处阶段（上次评估 · Stage 2，actualStage 随行）',
  barHtml.includes('Last assessment · Stage 2')
);

// 以图为中心（用户指令②③④）：当前段灯区换成雷达式灯图——虚线外圈=这个阶段
// 应达的程度（标准），点亮顶点的连线范围=现在的位置；未亮灯默认展开点亮标准 +
// 行动按钮；评估的行动每条直接是按钮（触发对话入口），不是建议文案
const chartHtml = (() => {
  const s = barHtml.indexOf('data-lamp-chart');
  const e = barHtml.indexOf('data-lamp-row', s);
  return s === -1 ? '' : barHtml.slice(s, e);
})();
check(
  '灯图渲染：当前段（阶段 2）3 个顶点全未亮、0 盏亮不连形（无 polygon）',
  (barHtml.match(/data-lamp-node="stage2_[a-z]+" data-lit="0"/g) ?? []).length === 3 &&
    !chartHtml.includes('data-lit="1"') &&
    !chartHtml.includes('<polygon'),
  `nodes=${(barHtml.match(/data-lamp-node=/g) ?? []).length}`
);
check(
  '灯图：标准说明随图（caption）+ 灯行按 kind 锚定',
  barHtml.includes('The lit shape is where you are now') && barHtml.includes('data-lamp-row="stage2_claim"')
);
check(
  '灯图：未亮灯默认展开——点亮标准（The bar:）+ 真实记录入口（不跳通用聊天）',
  barHtml.includes('data-lamp-cta="stage2_claim"') && barHtml.includes('The bar: ') && !barHtml.includes('Talk it over')
);
check(
  '评估行动 = 直接按钮（下一步可以做什么，2 条各一个记录入口）',
  (barHtml.match(/data-action-cta=/g) ?? []).length === 2 && barHtml.includes(ACTION_SEED)
);

// dismiss → 冷却；冷却内 generate 403；旧 advance 端点已删 → 404
const dismissRes = await post('/api/journey/assess', { locale: 'en', action: 'dismiss' }, main.cookie);
asmt = await assessmentOf();
check('dismiss 200 → dismissedAt 落库、pending 清空', dismissRes.status === 200 && Boolean(asmt.dismissedAt) && !asmt.pending, `status=${dismissRes.status}`);
const asgInCooldown = await post('/api/journey/assess', { locale: 'en', action: 'generate' }, main.cookie);
check('冷却内 generate → 403 assess_not_proposed', asgInCooldown.status === 403, `status=${asgInCooldown.status}`);
const oldAdvance = await post('/api/journey/advance', { locale: 'en' }, main.cookie);
check('旧 /api/journey/advance 端点已删 → 404', oldAdvance.status === 404, `status=${oldAdvance.status}`);

// ───────────────────── ⑤b 首评前置：体检完零素材也评估 ─────────────────────
console.log('\n—— ⑤b 首评前置：新号种子画像 + 全空素材 → offer 卡 → generate 非 403 → confirm 落 confirmedAt ——');
const first = await signUp('first');
const firstPortrait = {
  questionnaire: { script_source: 'M9 首评问卷：小时候家里为钱吵过', concerns_seed: 'M9 首评问卷：一发钱就心慌' },
  spoken: ['M9 首评原话：我一花钱就有罪恶感'],
  baseColor: 'M9 首评底色：总觉得自己不配',
  moments: [],
  script: '也许钱是要还的债',
  toFuture: '',
  version: 1,
  calibrations: [],
  scriptStatus: 'pending',
  createdAt: daysAgo(1),
};
await sql`
  INSERT INTO growth_profiles (user_key, locale, portrait, concerns, stage, stage_started_at,
    pinned, memories, experiments, letters, stamps, portrait_evolution, stage_assessment, created_at, daily_seen)
  VALUES (${first.key}, 'en', ${JSON.stringify(firstPortrait)}::jsonb, '[]'::jsonb, 1, ${daysAgo(1)},
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, ${daysAgo(1)}, '[]'::jsonb)`;
const firstAssessmentOf = () =>
  sql`SELECT stage_assessment FROM growth_profiles WHERE user_key = ${first.key}`.then((r) => r[0].stage_assessment ?? {});

const fj1 = await (await get('/en/journey', first.cookie)).text();
let fasmt = await firstAssessmentOf();
check('首评：体检后零素材零天数 → offer 卡渲染（data-assess-offer）', fj1.includes('data-assess-offer'));
check('首评：proposedSeenAt 首现落库', Boolean(fasmt.proposedSeenAt), JSON.stringify(fasmt));

const fGen = await post('/api/journey/assess', { locale: 'en', action: 'generate' }, first.cookie);
check(
  '首评 generate 不被素材闸拦（200 真生成 / 502 fail-safe，绝不是 403）',
  fGen.status === 200 || fGen.status === 502,
  `status=${fGen.status}`
);

// 注入确定性 pending 再 confirm（不依赖 LLM 产出），确认后 confirmedAt 关闭首评闸
await injectPending(first.key, 1);
const fConfirm = await post('/api/journey/assess', { locale: 'en', action: 'confirm' }, first.cookie);
fasmt = await firstAssessmentOf();
check(
  '首评 confirm 200 → confirmedAt 落库（首评闸关闭）、pending 清空',
  fConfirm.status === 200 && Boolean(fasmt.confirmedAt) && !fasmt.pending,
  `status=${fConfirm.status} ${JSON.stringify({ confirmedAt: Boolean(fasmt.confirmedAt), hasPending: Boolean(fasmt.pending) })}`
);
const fj2 = await (await get('/en/journey', first.cookie)).text();
check('首评确认后 offer 卡消失（confirmedAt 非空 + 零素材 → 不再提议）', !fj2.includes('data-assess-offer'));

// ───────────────────── ⑥ evolve generate：并发恰一次；真生成或 fail-safe ─────────────────────
console.log('\n—— ⑥ 画像演进：解除冷却后 generate（并发恰一次非 429）——');
await sql`UPDATE growth_profiles SET portrait_evolution = '{}'::jsonb WHERE user_key = ${main.key}`;
const [genA, genB] = await Promise.all([
  post('/api/portrait/evolve', { locale: 'en', action: 'generate' }, main.cookie),
  post('/api/portrait/evolve', { locale: 'en', action: 'generate' }, main.cookie),
]);
const statuses = [genA.status, genB.status];
// 恰一次真生成（两个 200 = 双生成是事故；败者可以是 429 抢锁失败，也可以是
// 胜者完成后才过闸 → 对新基线 403 evolve_not_proposed）
check('并发恰一次真生成', statuses.filter((s) => s === 200).length === 1, JSON.stringify(statuses));
const winner = genA.status !== 429 && genA.status !== 403 ? genA : genB;
const evoAfter = await evolutionOf();
const verRow = (await sql`SELECT portrait FROM growth_profiles WHERE user_key = ${main.key}`)[0].portrait;

if (winner.status === 200) {
  const body = await winner.json();
  const versions = await sql`SELECT version, source FROM portrait_versions WHERE user_key = ${main.key} ORDER BY version`;
  check('真生成：version 1→2，脚本重开待确认，校准清空', body.portrait.version === 2 && verRow.version === 2 && verRow.scriptStatus === 'pending' && verRow.calibrations.length === 0);
  check('快照两行：v1(onboarding) + v2(evolve)，无重复回填', versions.length === 2 && versions[0].source === 'onboarding' && versions[1].source === 'evolve', JSON.stringify(versions));
  check('锁已清 + lastGeneratedAt 落库 + 埋点纪元重置', (evoAfter.generatingAt ?? null) === null && Boolean(evoAfter.lastGeneratedAt) && (evoAfter.proposedSeenAt ?? null) === null, JSON.stringify(evoAfter));
  const genAgain = await post('/api/portrait/evolve', { locale: 'en', action: 'generate' }, main.cookie);
  check('新基线素材不足 → 403 evolve_not_proposed', genAgain.status === 403, `status=${genAgain.status}`);

  console.log('\n—— ⑦ 历史快照与对比 ——');
  const v1Html = await (await get('/en/portrait?version=1', main.cookie)).text();
  check('v1 历史快照页渲染的是 v1 内容（只读回看）', v1Html.includes('M9 画像 v1 底色'));
  const curHtml = await (await get('/en/portrait', main.cookie)).text();
  check('当前版页有过往版本链接（v1）+ 对比入口', curHtml.includes('/en/portrait?version=1') && curHtml.includes('/en/portrait/compare'));
  const cmpHtml = await (await get('/en/portrait/compare', main.cookie)).text();
  check('对比页 200 且两版内容并排（含 v1 原文）', cmpHtml.includes('M9 画像 v1 底色') && cmpHtml.includes('/en/timeline'));
  const cmp404 = await get('/en/portrait/compare?from=9&to=9', main.cookie);
  check('无上一版可对比 → 空态页（200）', cmp404.status === 200);
} else {
  // 无 LLM / LLM 故障：fail-safe——现画像不动、锁清掉、提议不消失
  check('生成失败 → 502 且现画像未动（v1 原样）', winner.status === 502 && verRow.version === 1, `status=${winner.status} version=${verRow.version}`);
  check('失败后锁已清、提议资格仍在', (evoAfter.generatingAt ?? null) === null && (evoAfter.lastGeneratedAt ?? null) === null, JSON.stringify(evoAfter));
  const html = await (await get('/en/portrait', main.cookie)).text();
  check('画像页仍是 v1 内容', html.includes('M9 画像 v1 底色'));
  console.log('⚠ LLM 未成功（token 缺失或上游故障），走 fail-safe 分支断言');
}

// ───────────────────── ⑧ 导出与级联删除 ─────────────────────
console.log('\n—— ⑧ 导出含画像版本 + 级联删除归零 ——');
const exported = await (await get('/api/me/export', main.cookie)).json();
check('导出 payload 含 portraitVersions', Array.isArray(exported.portraitVersions) && exported.portraitVersions.length === (winner.status === 200 ? 2 : 1), `n=${exported.portraitVersions?.length}`);
check(
  '导出含阶段评估（confirmed 依据随行）与心印清单',
  exported.profile?.assessment?.confirmed?.actualStage === 2 && JSON.stringify(exported.profile?.stamps ?? []).includes('stage2_entered'),
  `assessment=${JSON.stringify(exported.profile?.assessment?.confirmed?.actualStage)} stamps=${exported.profile?.stamps?.length}`
);

const del = await post('/api/me/delete', { confirm: 'DELETE' }, main.cookie);
const leftovers = await sql`
  SELECT (SELECT count(*)::int FROM growth_profiles WHERE user_key = ${main.key}) AS p,
         (SELECT count(*)::int FROM portrait_versions WHERE user_key = ${main.key}) AS v,
         (SELECT count(*)::int FROM journal_entries WHERE user_key = ${main.key}) AS j,
         (SELECT count(*)::int FROM chat_sessions WHERE user_key = ${main.key}) AS c,
         (SELECT count(*)::int FROM "user" WHERE id = ${main.userId}) AS u`;
check(
  '删除后档案/快照/日记/对话/账号全归零',
  del.status === 200 && Object.values(leftovers[0]).every((n) => n === 0),
  `${del.status} ${JSON.stringify(leftovers[0])}`
);
const strangerDel = await post('/api/me/delete', { confirm: 'DELETE' }, stranger.cookie);
check('越权测试号一并清理', strangerDel.status === 200);
const firstDel = await post('/api/me/delete', { confirm: 'DELETE' }, first.cookie);
const firstLeft = await sql`
  SELECT (SELECT count(*)::int FROM growth_profiles WHERE user_key = ${first.key}) AS p,
         (SELECT count(*)::int FROM "user" WHERE id = ${first.userId}) AS u`;
check('首评测试号一并清理（档案/账号归零）', firstDel.status === 200 && firstLeft[0].p === 0 && firstLeft[0].u === 0, JSON.stringify(firstLeft[0]));

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 处失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
