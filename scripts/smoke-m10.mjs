// M10 冒烟（微行动即时回应 + 《我变了什么》+ 0 元替代版 + 归因对照，Go/No-Go
// 机械可测部分）：/zh-CN/journey → stage2 0 元替代语随卡渲染、stage3 替代语不串场、
// changes 入口在场（种子已确认评估）→ experiment 首次完成：receipt 非空（LLM 或
// 词典降级）+ experiments 落库 + first_done / instant_response_shown 埋点；第二次
// 完成 → first_done 恰一次 → SQL 种子确认态（confirmed + previousConfirmed 对照态）
// → changes POST：真生成（200 cached:false + forConfirmedAt 对齐 + generated 埋点）
// 或无 LLM 502 fail-safe（锁清、缓存不落）→ /journey/changes 渲染新灯依据 +
// viewed 埋点 → 再 POST cached:true 不重复生成 → 注入 pending → confirm →
// previousConfirmed=旧 confirmed、confirmedAt 更新、narration 缓存过期 → 导出含
// previousConfirmed/changeList → 级联删除归零（含 events）。文案断言全部用数据
// 驱动边界（种子内容/正文 frontmatter/href）——RSC flight 会把整份词典序列化进
// HTML，grep 词典文案必假阳性。
// 运行：dev server 在 3000 + node --env-file=.env.local scripts/smoke-m10.mjs
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
  const email = `m10-${tag}-${crypto.randomUUID().slice(0, 8)}@smoke.test`;
  const username = `smoke10${crypto.randomUUID().slice(0, 6)}`;
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

const assessmentOf = () =>
  sql`SELECT stage_assessment FROM growth_profiles WHERE user_key = ${main.key}`.then((r) => r[0].stage_assessment ?? {});
const eventCount = (key, name) =>
  sql`SELECT count(*)::int AS n FROM events WHERE user_key = ${key} AND name = ${name}`.then((r) => r[0].n);

// ───────────────────── ① 注册 + SQL 种子档案（stage2 + 已确认评估对照态） ─────────────────────
console.log('\n—— ① 注册测试号 + 种子（画像 / stage=2 / confirmed + previousConfirmed 对照态）——');
const main = await signUp('main');
check('注册主测试账号', Boolean(main.cookie && main.userId), main.key);

// free_alt 断言文本 = content/zh-CN/journey/{2-松动,3-练习}.md frontmatter 原文（契约检查）
const FREE_ALT_STAGE2 = '把一直舍不得用的一件东西用起来，或给自己放半天假——允许自己，不一定要花钱。';
const FREE_ALT_STAGE3 = '把「允许」用在不花钱的事上：拒绝一个不想去的邀约、睡前提前一小时躺下、白白休息一个下午。';
const OLD_EVIDENCE = 'M10 旧依据：小时候家里的账单总在饭桌上摊着';
const NEW_EVIDENCE_B = 'M10 新依据：你说那不是债，是怕花完就没有';
const NEW_EVIDENCE_C = 'M10 新依据：你把舍不得用的那件东西拿了出来';
const SUMMARY_SEED = 'M10 总结种子：它看到你把那个故事讲了出来。';
const DIAG_SEED = 'M10 诊断种子：账单摊在饭桌上的那些晚上，把「不配」拧成了底色。';
const ACTION_SEED = 'M10 行动种子：这周把那件舍不得用的东西用起来一次。';

const portrait = {
  spoken: ['M10 原话：我一花钱就有罪恶感'],
  baseColor: 'M10 底色：总觉得自己不配花这笔钱',
  moments: [],
  script: '也许钱是要还的债',
  toFuture: '',
  version: 1,
  calibrations: [],
  scriptStatus: 'confirmed',
  createdAt: daysAgo(30),
};
// 上次确认（60 天前）：只有 story 亮 → 变化清单的新灯差集 = 本次新亮的 script + color
const prevConfirmed = {
  actualStage: 1,
  lamps: [
    { kind: 'stage1_story', lit: true, evidence: OLD_EVIDENCE },
    { kind: 'stage1_script', lit: false, evidence: '' },
    { kind: 'stage1_color', lit: false, evidence: '' },
  ],
  summary: 'M10 上次总结：它先看见你的故事。',
  diagnosis: 'M10 上次诊断：先有故事，后有底色。',
  distance: 'M10 上次距离：路刚开头。',
  actions: ['M10 上次行动：把故事讲一次。'],
  nextHint: '',
  assessedAt: daysAgo(60),
};
// 本次确认（10 天前）：三盏全亮，script/color 带新依据——对照 prev 产生两盏新灯；
// ⑦ confirm 后 previousConfirmed 被它接棒
const currConfirmed = {
  actualStage: 1,
  lamps: [
    { kind: 'stage1_story', lit: true, evidence: OLD_EVIDENCE },
    { kind: 'stage1_script', lit: true, evidence: NEW_EVIDENCE_B },
    { kind: 'stage1_color', lit: true, evidence: NEW_EVIDENCE_C },
  ],
  summary: SUMMARY_SEED,
  diagnosis: DIAG_SEED,
  distance: 'M10 距离种子：你已经敢看这个故事了。',
  actions: [ACTION_SEED],
  nextHint: '',
  assessedAt: daysAgo(10),
};
const CONFIRMED_AT_0 = daysAgo(10);
const stageAssessment = {
  pending: null,
  confirmed: currConfirmed,
  confirmedAt: CONFIRMED_AT_0,
  dismissedAt: null,
  generatingAt: null,
  proposedSeenAt: null,
  previousConfirmed: prevConfirmed,
  changeList: null,
  changeListLockAt: null,
};
await sql`
  INSERT INTO growth_profiles (user_key, locale, portrait, concerns, stage, stage_started_at,
    pinned, memories, experiments, letters, stamps, portrait_evolution, stage_assessment, created_at, daily_seen)
  VALUES (${main.key}, 'zh-CN', ${JSON.stringify(portrait)}::jsonb, '[]'::jsonb, 2, ${daysAgo(10)},
    '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
    ${JSON.stringify(stageAssessment)}::jsonb, ${daysAgo(30)}, '[]'::jsonb)`;
check('档案落库（stage=2，confirmed + previousConfirmed 对照态）', true);

// ───────────────────── ② journey 页：0 元替代语 + changes 入口 ─────────────────────
console.log('\n—— ② journey 页：stage2 替代语在场、stage3 不串场、changes 入口在场 ——');
const journeyRes = await get('/zh-CN/journey', main.cookie);
const journeyHtml = await journeyRes.text();
check('journey 200', journeyRes.status === 200, `status=${journeyRes.status}`);
check('0 元替代语随卡渲染（stage2 free_alt 数据驱动）', journeyHtml.includes(FREE_ALT_STAGE2));
check('其他阶段的替代语不串场（stage3 free_alt 不在场）', !journeyHtml.includes(FREE_ALT_STAGE3));
check('changes 入口在场（已确认评估 → 确认报告块尾部链接）', journeyHtml.includes('href="/zh-CN/journey/changes"'));
check('确认报告块渲染（总结/诊断种子在场）', journeyHtml.includes(SUMMARY_SEED) && journeyHtml.includes(DIAG_SEED));

// ───────────────────── ③④ 微行动：即时见证回应 + 首次埋点 ─────────────────────
console.log('\n—— ③④ 微行动：receipt 非空 + 首次埋点恰一次 ——');
const expA = await post(
  '/api/journey/experiment',
  { action: 'M10 微行动：把舍不得用的台灯搬回了卧室', feeling: 'M10 感受：有点心虚，但灯很亮', locale: 'zh-CN' },
  main.cookie
);
const expABody = await expA.json();
check('首次微行动 200 + receipt 非空（LLM 或词典降级）', expA.status === 200 && typeof expABody.receipt === 'string' && expABody.receipt.length > 0, `status=${expA.status} len=${expABody.receipt?.length}`);
const expCount = () =>
  sql`SELECT jsonb_array_length(experiments) AS n FROM growth_profiles WHERE user_key = ${main.key}`.then((r) => r[0].n);
check('experiments 落库（1 条）', (await expCount()) === 1);
check(
  '埋点三连：experiment_saved / micro_action_first_done / micro_action_instant_response_shown',
  (await eventCount(main.key, 'experiment_saved')) === 1 &&
    (await eventCount(main.key, 'micro_action_first_done')) === 1 &&
    (await eventCount(main.key, 'micro_action_instant_response_shown')) === 1
);

await post(
  '/api/journey/experiment',
  { action: 'M10 微行动：给自己泡了壶好茶慢慢喝', locale: 'zh-CN' },
  main.cookie
);
check('第二次完成：experiments=2，first_done 恰一次不重复', (await expCount()) === 2 && (await eventCount(main.key, 'micro_action_first_done')) === 1);

// ───────────────────── ⑤ 变化清单：生成（真生成或 502 fail-safe） ─────────────────────
console.log('\n—— ⑤ 变化清单 POST：真生成 cached:false / 无 LLM 502 fail-safe ——');
let asmt = null;
const chg1 = await post('/api/journey/changes', { locale: 'zh-CN' }, main.cookie);
let narrationText = '';
if (chg1.status === 200) {
  const body = await chg1.json();
  narrationText = body.changeList?.text ?? '';
  asmt = await assessmentOf();
  check(
    '真生成：cached:false + forConfirmedAt 对齐本次确认 + 文本非空',
    body.cached === false && body.changeList?.forConfirmedAt === CONFIRMED_AT_0 && narrationText.length > 0,
    `len=${narrationText.length}`
  );
  check('缓存落库（changeList.forConfirmedAt === confirmedAt）', asmt.changeList?.forConfirmedAt === asmt.confirmedAt);
  check('生成埋点 change_list_generated（cached=false）', (await eventCount(main.key, 'change_list_generated')) === 1);
} else {
  asmt = await assessmentOf();
  check(
    '生成失败 → 502 fail-safe：锁已清、缓存不落',
    chg1.status === 502 && (asmt.changeListLockAt ?? null) === null && !asmt.changeList,
    `status=${chg1.status} ${JSON.stringify({ lock: asmt.changeListLockAt, hasList: Boolean(asmt.changeList) })}`
  );
  console.log('⚠ LLM 未成功（token 缺失或上游故障），变化清单走 fail-safe 分支断言');
}

// ───────────────────── ⑥ 变化清单页：结构直出 + viewed 埋点 ─────────────────────
console.log('\n—— ⑥ /journey/changes：新灯依据渲染（结构化部分不依赖 LLM）——');
const changesHtml = await (await get('/zh-CN/journey/changes', main.cookie)).text();
check('changes 页 200', changesHtml.length > 500);
check('新灯差集渲染：script + color 的种子依据在场', changesHtml.includes(NEW_EVIDENCE_B) && changesHtml.includes(NEW_EVIDENCE_C));
check('旧灯不进新灯清单（story 的旧依据不在 changes 页）', !changesHtml.includes(OLD_EVIDENCE));
if (narrationText) check('叙述段（LLM）直出渲染', changesHtml.includes(narrationText.slice(0, 40)));
check(
  '下一步是按钮不是干条目：行动按钮锚点在场且文案是本次确认的行动',
  changesHtml.includes('data-action-cta="0"') && changesHtml.includes(ACTION_SEED)
);
check('viewed 埋点落库', (await eventCount(main.key, 'change_list_viewed')) === 1);

// 幂等：缓存命中不重烧 LLM（仅真生成成功时断言）
if (chg1.status === 200) {
  const chg2 = await post('/api/journey/changes', { locale: 'zh-CN' }, main.cookie);
  const chg2Body = await chg2.json();
  check(
    '第二次 POST cached:true + 文本一致 + 不重复生成（generated 仍 1）',
    chg2.status === 200 && chg2Body.cached === true && chg2Body.changeList?.text === narrationText &&
      (await eventCount(main.key, 'change_list_generated')) === 1,
    `status=${chg2.status} cached=${chg2Body.cached}`
  );
}

// ───────────────────── ⑦ confirm：previousConfirmed 承接 + 缓存过期 ─────────────────────
console.log('\n—— ⑦ 注入 pending → confirm：previousConfirmed=旧 confirmed、confirmedAt 更新、narration 过期 ——');
const PENDING_EVIDENCE = 'M10 第二轮依据：你把「允许」第一次用在了不花钱的事上';
const pending = {
  actualStage: 2,
  lamps: [
    { kind: 'stage1_story', lit: true, evidence: OLD_EVIDENCE },
    { kind: 'stage1_script', lit: true, evidence: NEW_EVIDENCE_B },
    { kind: 'stage1_color', lit: true, evidence: PENDING_EVIDENCE },
  ],
  summary: 'M10 第二轮总结：它看到你开始允许自己。',
  diagnosis: 'M10 第二轮诊断：允许不是奖励，是本来的权利。',
  distance: 'M10 第二轮距离：路标越来越近。',
  actions: ['M10 第二轮行动：再找一件舍不得用的东西。'],
  nextHint: 'M10 下一阶段：练习期。',
  assessedAt: new Date().toISOString(),
};
await sql`UPDATE growth_profiles SET stage_assessment = jsonb_set(stage_assessment, '{pending}', ${JSON.stringify(pending)}::jsonb) WHERE user_key = ${main.key}`;
const confirmRes = await post('/api/journey/assess', { locale: 'zh-CN', action: 'confirm' }, main.cookie);
asmt = await assessmentOf();
check(
  'confirm 200 → previousConfirmed 承接旧 confirmed（assessedAt/summary/依据逐项）、pending 清空、confirmedAt 已更新',
  confirmRes.status === 200 && !asmt.pending &&
    asmt.previousConfirmed?.assessedAt === currConfirmed.assessedAt &&
    asmt.previousConfirmed?.summary === SUMMARY_SEED &&
    asmt.previousConfirmed?.lamps?.[2]?.evidence === NEW_EVIDENCE_C &&
    asmt.confirmed?.summary === pending.summary &&
    asmt.confirmedAt !== CONFIRMED_AT_0,
  `status=${confirmRes.status} ${JSON.stringify({ hasPrev: Boolean(asmt.previousConfirmed), confirmedAtMoved: asmt.confirmedAt !== CONFIRMED_AT_0 })}`
);
check('旧 narration 缓存过期（forConfirmedAt ≠ 新 confirmedAt）', asmt.changeList?.forConfirmedAt !== asmt.confirmedAt);
check('stage_assessment_confirmed 埋点', (await eventCount(main.key, 'stage_assessment_confirmed')) === 1);

// ───────────────────── ⑧ 导出与级联删除 ─────────────────────
console.log('\n—— ⑧ 导出含 previousConfirmed/changeList + 级联删除归零（含 events）——');
const exported = await (await get('/api/me/export', main.cookie)).json();
check(
  '导出含 previousConfirmed 与 changeList（评估 JSONB 整对象随行）',
  exported.profile?.assessment?.previousConfirmed?.summary === SUMMARY_SEED &&
    (exported.profile?.assessment?.changeList == null || typeof exported.profile.assessment.changeList.text === 'string'),
  `prev=${Boolean(exported.profile?.assessment?.previousConfirmed)}`
);

const del = await post('/api/me/delete', { confirm: 'DELETE' }, main.cookie);
const leftovers = await sql`
  SELECT (SELECT count(*)::int FROM growth_profiles WHERE user_key = ${main.key}) AS p,
         (SELECT count(*)::int FROM journal_entries WHERE user_key = ${main.key}) AS j,
         (SELECT count(*)::int FROM events WHERE user_key = ${main.key}) AS e,
         (SELECT count(*)::int FROM "user" WHERE id = ${main.userId}) AS u`;
check(
  '删除后档案/日记/事件/账号全归零',
  del.status === 200 && Object.values(leftovers[0]).every((n) => n === 0),
  `${del.status} ${JSON.stringify(leftovers[0])}`
);

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 处失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
