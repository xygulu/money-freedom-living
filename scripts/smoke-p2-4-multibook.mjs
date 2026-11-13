// P2-4 假第二本书 E2E（docs/08 P2-4：「显示正确 ≠ 架构通了——只有接第二本才暴露」）。
//
// 路线：用**一次性 fixture 书**（book-e2efixture，程序生成、结构过发布闸、跑完即删），
// 不动 book-mubvxgl6 / book-mubuqodp 两本真 draft——真书上线路径仍要求人工校正后发布
// （C4 口径），那是运营动作，不是冒烟能替的。
//
// 流程：
//   ① 生成 fixture 书（meta + lamps + en/zh-CN journey 4 段 + 一签池 90×2 语言）
//   ② pnpm build-content 过发布闸（active 硬闸：非末段每段 ≥1 灯 / 一签 ≥90 / 正文 ≥100）
//   ③ 重启内容装载（本脚本假定调用方已重启 dev server；或跑前先 node 本脚本 --prepare）
//   ④ HTTP 全流程：注册 → select v1 → add fixture → books[] 双 active →
//      journey-new 归属行两本书 → /road 书目多一本 → 加书入口消失（候选空不渲染）
//   ⑤ 清理：删 fixture → 重建 content.json（调用方再重启一次恢复）
//
// 运行：dev server 在 3000 + node --env-file=.env.local scripts/smoke-p2-4-multibook.mjs
// 前置：先 node scripts/smoke-p2-4-multibook.mjs --prepare（生成 fixture + 构建），
//       重启 dev server 后再不带参数跑全流程。
import { neon } from '@neondatabase/serverless';
import * as crypto from 'crypto';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = join(ROOT, 'content/books/book-e2efixture');
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3000';
let failures = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
  if (!cond) failures++;
}

const TITLE = 'E2E 假第二本书';
const KINDS = {
  1: ['e2e_s1_kind'],
  2: ['e2e_s2_kind'],
  3: ['e2e_s3_kind'],
};

const LABELS = {
  1: { en: 'First e2e lamp', 'zh-CN': '假书一盏灯', 'zh-TW': '假書一盞燈', ja: 'テストの灯' },
  2: { en: 'Second e2e lamp', 'zh-CN': '假书又一盏', 'zh-TW': '假書又一盞', ja: 'もう一つの灯' },
  3: { en: 'Third e2e lamp', 'zh-CN': '假书第三盏', 'zh-TW': '假書第三盞', ja: '三つ目の灯' },
};

const STAGE_TITLES = { en: ['See', 'Loosen', 'Try', 'Live'], 'zh-CN': ['看见', '松动', '试过', '过日子'] };

function lampLine(stage, kind) {
  const l = LABELS[stage];
  const four = (k) => JSON.stringify({ en: l[k], 'zh-CN': l[k], 'zh-TW': l[k], ja: l[k] });
  return `  - kind: ${kind}
    topic: money-safety
    needsAction: ${stage === 2}
    promptHint: E2E fixture 程度句式（内部备注）
    label: ${four('en')}
    hint: ${four('en')}`;
}

function writeFixture() {
  if (existsSync(FIXTURE_DIR)) rmSync(FIXTURE_DIR, { recursive: true });
  const write = (rel, content) => {
    mkdirSync(dirname(join(FIXTURE_DIR, rel)), { recursive: true });
    writeFileSync(join(FIXTURE_DIR, rel), content);
  };

  write('meta.md', `---
id: book-e2efixture
title:
  en: "${TITLE} EN"
  zh-CN: ${TITLE}
  zh-TW: E2E 假第二本書
  ja: E2Eテストの本
author: E2E Smoke
source: fixture
status: active
topics:
  - money-safety
  - self-worth
---

一次性 fixture：P2-4 多书 E2E 专用，跑完即删，不是真书。
`);

  write('lamps.md', `---
stages:
  1:
${KINDS[1].map((k) => lampLine(1, k)).join('\n')}
  2:
${KINDS[2].map((k) => lampLine(2, k)).join('\n')}
  3:
${KINDS[3].map((k) => lampLine(3, k)).join('\n')}
---
`);

  for (const locale of ['en', 'zh-CN']) {
    for (const id of [1, 2, 3, 4]) {
      const title = STAGE_TITLES[locale][id - 1];
      const body = `E2E fixture 第 ${id} 段正文。这段文字只是为了让发布闸的「正文 ≥100 字符」过关——`.repeat(4);
      write(
        `${locale}/journey/${id}.md`,
        `---
id: ${id}
title: ${title}
goal: E2E fixture 阶段目标（不是真内容）
weeks: 3
exercises:
  - "E2E fixture 练习 ${id}：写下一条观察"
ai_stance:
  do:
    - "接住用户原话"
  dont:
    - "不给理财建议"
advance_when:
  - "E2E fixture 推进条件"
ritual: E2E fixture 仪式
free_alt: 不花钱的替代：只看一眼这一段也算
skippable: true
topics:
  - money-safety
---

${body}
`,
      );
    }

    // 一签池：90 条唯一文案，type 三型轮转、stages 四段轮转、topics 1-2 个
    const pool = [];
    const TYPES = ['observation', 'practice', 'way'];
    const TOPIC_SETS = [['money-safety'], ['money-safety', 'self-worth'], ['self-worth']];
    for (let i = 1; i <= 90; i++) {
      pool.push({
        text: `E2E fixture 一签 ${i}（${locale}）：今天只看一眼它，不要求做任何事。`,
        reflection: `E2E fixture 反问 ${i}：它让你想起什么？`,
        type: TYPES[i % 3],
        stages: [((i - 1) % 4) + 1],
        topics: TOPIC_SETS[i % 3],
      });
    }
    write(`${locale}/daily/pool.json`, JSON.stringify(pool, null, 2));
  }
}

// ---------- CLI 分派 ----------
if (process.argv[2] === '--prepare') {
  writeFixture();
  execSync('node scripts/build-content.mjs', { cwd: ROOT, stdio: 'inherit' });
  console.log('\nfixture 已生成并过构建。现在重启 dev server（让 content bundle 装载 fixture），再不带参数跑本脚本。');
  process.exit(0);
}
if (process.argv[2] === '--cleanup') {
  if (existsSync(FIXTURE_DIR)) rmSync(FIXTURE_DIR, { recursive: true });
  execSync('node scripts/build-content.mjs', { cwd: ROOT, stdio: 'inherit' });
  console.log('\nfixture 已删除，content.json 已重建。重启 dev server 恢复正常内容。');
  process.exit(0);
}

// ---------- E2E 主流程 ----------
const FIXTURE_ID = 'book-e2efixture';
const sql = neon(process.env.DATABASE_URL);
const bundle = JSON.parse(readFileSync(join(ROOT, 'src/generated/content.json'), 'utf8'));

function cookiesOf(res) {
  return (res.headers.get('set-cookie') ?? '')
    .split(',')
    .map((c) => c.split(';')[0].trim())
    .filter((c) => c.includes('='))
    .join('; ');
}

async function signUp(tag) {
  const email = `p24-${tag}-${crypto.randomUUID().slice(0, 8)}@smoke.test`;
  const username = `smokep24${crypto.randomUUID().slice(0, 6)}`;
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

const booksOf = (key) =>
  sql`SELECT books FROM growth_profiles WHERE user_key = ${key}`.then((r) => r[0]?.books ?? []);

console.log('\n—— ⓪ 前置：fixture 已构建进 content.json（--prepare 已跑）；服务端是否装载在 ① 里由 add 的成败直接检验 ——');
check(
  'content.json 含 fixture 书（status active，过发布闸）',
  bundle.books.some((b) => b.id === FIXTURE_ID && b.status === 'active'),
  `catalog: ${bundle.books.map((b) => b.id).join(', ')}`,
);

console.log('\n—— ① 汇入制加书：select v1 → add fixture → books[] 双 active ——');
const user = await signUp('mb');
check('smoke 用户注册', Boolean(user.cookie && user.userId), user.email);

let res = await post('/api/me/books', { bookId: 'money-freedom', mode: 'select', locale: 'zh-CN' }, user.cookie);
check('select v1 落库（200）', res.status === 200, `status=${res.status}`);
let books = await booksOf(user.key);
check('books[] = [money-freedom active]', books.length === 1 && books[0].bookId === 'money-freedom' && books[0].status === 'active');

res = await post('/api/me/books', { bookId: FIXTURE_ID, mode: 'add', locale: 'zh-CN' }, user.cookie);
check('add fixture 落库（200，汇入制不暂停任何书）', res.status === 200, `status=${res.status}`);
books = await booksOf(user.key);
check(
  'books[] 双 active（v1 不动 + fixture 进来）',
  books.length === 2 && books.every((b) => b.status === 'active') && books.some((b) => b.bookId === FIXTURE_ID),
  JSON.stringify(books.map((b) => `${b.bookId}:${b.status}`)),
);

console.log('\n—— ② 用户面：旅程页归属行两本书 + 加书入口消失 + /road 书目多一本 ——');
const journeyHtml = await get('/zh-CN/journey-new', user.cookie).then((r) => r.text());
check(
  'journey-new 归属行（data-book-attribution）同时列出两本书',
  journeyHtml.includes('data-book-attribution') && journeyHtml.includes(TITLE),
);
check('加书入口消失（候选空整个不渲染，红线 1）', !journeyHtml.includes('data-add-book-entry'));

const roadHtml = await get('/zh-CN/road', user.cookie).then((r) => r.text());
check('/road 书目多一本（data-road-book=fixture）', roadHtml.includes(`data-road-book="${FIXTURE_ID}"`));

console.log('\n—— ③ 主线归属：行级 stage 真源仍归最早开始的 active（v1），不被 add 进来的书顶掉 ——');
// add 模式 = 已有书不动：v1 仍是主线（阶段叙事/灯表/评估跟它）。books[0] 是 v1 且行级
// stage 与 books[] 内条目一致 = 主线归属没变。
const rowStage = await sql`SELECT stage, books FROM growth_profiles WHERE user_key = ${user.key}`.then((r) => r[0]);
const mainline = (rowStage?.books ?? []).find((b) => b.bookId === 'money-freedom');
check('主线仍是 v1 且行级 stage 与条目一致', Boolean(mainline) && mainline.stage === (rowStage?.stage ?? -1), `stage=${rowStage?.stage}`);

console.log('\n—— ④ 收尾：清理 ——');
console.log('清理步骤在脚本外执行：node scripts/smoke-p2-4-multibook.mjs --cleanup（然后重启 dev server）。');

if (failures > 0) {
  console.error(`\n${failures} 项未过 —— P2-4 E2E 未通过`);
  process.exit(1);
}
console.log('\n✅ P2-4 假第二本书 E2E 全过');
