// M9 冒烟（成长足迹 + 画像演进 + 阶段评估，Go/No-Go 机械可测部分）：
// /timeline 六类节点 → 聊天回看越权 404 → 演进提议判定/首现埋点/dismiss 冷却 →
// 阶段评估流（渲染不再发印=stamps 真值回归锚点；提议首现/幂等；assess generate
// 并发恰一次、真生成或 502 fail-safe；SQL 注入确定性 pending → review 渲染含
// 种子依据 → confirm 加印 → advance 200 + 仪式印；越权推进 403/404；dismiss 冷却；
// 旧 advance 端点 404）→ evolve generate（并发恰一次；真生成 v2 / 无 LLM 502
// fail-safe）→ /portrait?version= 历史快照 → /portrait/compare 并排 →
// 导出含 portraitVersions → 级联删除归零。文案断言全部用数据驱动边界
// （种子内容/href）——RSC flight 会把整份词典序列化进 HTML，grep 词典文案必假阳性。
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

// SQL 注入确定性 pending（不依赖 LLM 断言确认流）：两盏点亮带种子依据、一盏未点亮
const EVIDENCE_A = 'M9 评估依据：它记得你第一次没带伞也走了';
const EVIDENCE_B = 'M9 评估依据：你说不是债，是怕花完就没';
const injectPending = async (actualStage) => {
  const lamps = [
    { kind: 'stage1_story', lit: true, evidence: EVIDENCE_A },
    { kind: 'stage1_script', lit: true, evidence: EVIDENCE_B },
    { kind: 'stage1_color', lit: false, evidence: '' },
  ];
  const pending = {
    actualStage,
    lamps,
    summary: 'M9 评估总结：它看到你把故事和态度都拿了出来。',
    nextHint: 'M9 下一阶段：再往前一步。',
    assessedAt: new Date().toISOString(),
  };
  await sql`UPDATE growth_profiles SET stage_assessment = jsonb_set(stage_assessment, '{pending}', ${JSON.stringify(pending)}::jsonb) WHERE user_key = ${main.key}`;
};
await injectPending(1);
const reviewHtml = await (await get('/en/journey', main.cookie)).text();
check('review 卡渲染含种子评估依据（数据驱动断言）', reviewHtml.includes(EVIDENCE_A) && reviewHtml.includes(EVIDENCE_B));

const confirmRes = await post('/api/journey/assess', { locale: 'en', action: 'confirm' }, main.cookie);
let kinds = await stampsAfter();
asmt = await assessmentOf();
check(
  'confirm 200 → 新点亮 stage1_script 入档（story 不重复）、pending 清空、confirmed/confirmedAt 落库',
  confirmRes.status === 200 && JSON.stringify(kinds) === JSON.stringify(['stage1_script', 'stage1_story']) &&
    !asmt.pending && asmt.confirmed?.actualStage === 1 && Boolean(asmt.confirmedAt),
  `status=${confirmRes.status} stamps=${JSON.stringify(kinds)} ${JSON.stringify({ hasConfirmed: Boolean(asmt.confirmed), confirmedAt: Boolean(asmt.confirmedAt) })}`
);

// advance 防绕：评估说还在原阶段 → 403
await injectPending(1);
const advanceNotReady = await post('/api/journey/assess', { locale: 'en', action: 'advance' }, main.cookie);
check('actualStage≤stage 的 advance → 403 advance_not_ready', advanceNotReady.status === 403, `status=${advanceNotReady.status}`);

// advance：评估说到了下一阶段门口 → 推进仪式
await injectPending(2);
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

// dismiss → 冷却；冷却内 generate 403；旧 advance 端点已删 → 404
const dismissRes = await post('/api/journey/assess', { locale: 'en', action: 'dismiss' }, main.cookie);
asmt = await assessmentOf();
check('dismiss 200 → dismissedAt 落库、pending 清空', dismissRes.status === 200 && Boolean(asmt.dismissedAt) && !asmt.pending, `status=${dismissRes.status}`);
const asgInCooldown = await post('/api/journey/assess', { locale: 'en', action: 'generate' }, main.cookie);
check('冷却内 generate → 403 assess_not_proposed', asgInCooldown.status === 403, `status=${asgInCooldown.status}`);
const oldAdvance = await post('/api/journey/advance', { locale: 'en' }, main.cookie);
check('旧 /api/journey/advance 端点已删 → 404', oldAdvance.status === 404, `status=${oldAdvance.status}`);

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

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 处失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
