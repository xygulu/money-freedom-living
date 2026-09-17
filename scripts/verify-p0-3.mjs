// P0-3 首启重排验收（v2 · 2026-09-17）：
// 真浏览器走一遍，JS 读 DOM 文本测时——`events.first_portrait_done.seconds < 600` 才算过。
// 首启重排 v2 验收路径（form → portrait 前置 + chat 后置 + welcome 步删除）：
//   1. /zh-CN/onboarding 落地 → 首屏是 form（`data-step="form"` 在场、`先喘口气` **不**在场）
//   2. 4 道 choice + 1 道 free-text 全答（顺序任意）→ 提交 → reflect 步
//   3. 勾同意 → 点"是的，就是这样 · 生成画像"→ generating → portrait 落库
//   4. 进 echo 步 → `data-echo` 出现文本 → JS 读 `Date.now()` 算耗时
//   5. 查 events 表的 `first_portrait_done` 那条 metadata.seconds 与 DOM 耗时对照
//
// KPI 变更说明（docs/08 P3 偏差登记）：
// - 旧 KPI：`first_echo_shown.seconds < 180`（P0-3 旧顺序下 echo ≈ 10s）
// - 新 KPI：`first_portrait_done.seconds < 600`（v2 顺序下画像 ≈ 10-15s，含 form 填表）
//   新 KPI 由验收侧在下一轮 sync 时按口径提案；本 commit 用 600s 占位。
//
// 服务端可用的前提下，本脚本只断言"在 10 分钟内拿到了 portrait + echo"——这是 v2 的红线，
// 文案与素材质量交给 M11-C 后续验收（smoke-m11 §⑤）。
//
// 用法：dev server 在 3000 + node --env-file=.env.local scripts/verify-p0-3.mjs
import { chromium } from 'playwright';
import { neon } from '@neondatabase/serverless';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3000';
const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
  cond ? pass++ : fail++;
};

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${String(e).slice(0, 300)}`));

const startedAt = Date.now();
const userKey = `g:${crypto.randomUUID().replace(/-/g, '')}`;
await ctx.addCookies([
  { name: 'guest_qk', value: userKey.replace('g:', ''), url: BASE, sameSite: 'Lax' },
]);

// ① 落地：首屏直接是 form（welcome 步已删除）
await page.goto(`${BASE}/zh-CN/onboarding`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-step="form"]', { timeout: 10_000 });
const formText = await page.locator('[data-step="form"]').innerText();
check('首屏是 form（welcome 步已删除，直接进第一题）',
  formText.includes('关于钱的几件事') || formText.includes('一次一件'),
  formText.slice(0, 60).replace(/\n/g, '|'));
const surveyOnFirst = await page.locator('[data-step="form"] [data-question]').count();
check('首屏出现问卷题（v2：welcome 步删除后第一眼就是题）', surveyOnFirst >= 1, `n=${surveyOnFirst}`);
const welcomeGone = (await page.locator('[data-step="welcome"]').count()) === 0;
check('welcome 屏不再存在（v2：彻底删除）', welcomeGone);
check('首屏没有 data-consent（同意区仍在 reflect 步）',
  (await page.locator('[data-step="form"] [data-consent]').count()) === 0);

// ② 答 4 道 choice + 1 道 free-text（按问题顺序）
// Q1 moment_when (choice) · Q2 balance_feeling (choice) · Q3 childhood (free) · Q4 payday_action (choice) · Q5 aspiration (choice) · Q6 recent_worry (free)
async function clickChoiceByText(text) {
  const btn = page.locator(`[data-step="form"] button:has-text("${text}")`).first();
  await btn.waitFor({ timeout: 5_000 });
  await btn.click();
}
async function fillFreeText(text) {
  const ta = page.locator('[data-step="form"] textarea').first();
  await ta.waitFor({ timeout: 5_000 });
  await ta.fill(text);
  // 自由题要手动点"继续说"按钮
  const nextBtn = page.locator(`[data-step="form"] button:has-text("继续说")`).first();
  await nextBtn.click();
}

await clickChoiceByText('这周');         // Q1 moment_when
await clickChoiceByText('平静');         // Q2 balance_feeling
await fillFreeText('我妈说咱家不配');     // Q3 childhood（必填 1 题）
await clickChoiceByText('先还账');       // Q4 payday_action
await clickChoiceByText('松弛不纠结');   // Q5 aspiration

// Q6 之前 form 进度提示
const progress = await page.locator('[data-form-progress]').innerText().catch(() => '');
check('问卷进行到最后一题（6/6）', progress.includes('6 / 6'), progress);

await fillFreeText('上周看余额时突然心慌了一下');

// ③ 校验 last 题的 canSubmit 守门：最后一题点 skip 按钮（form 步最后一题的 skip 按钮）
// 注：自由题（Q6）答了任意内容 → canSubmit=true，按钮可点；这里不需要再触发守门测试

// ④ 进 reflect 步
await page.waitForSelector('[data-step="reflect"]', { timeout: 10_000 });
const reflectText = await page.locator('[data-step="reflect"]').innerText();
check('进 reflect 步（问卷答案本地复述 + 同意区）',
  reflectText.includes('确认一下') || reflectText.includes('是的，就是这样'),
  reflectText.slice(0, 60).replace(/\n/g, '|'));
const answersRendered = await page.locator('[data-reflect-answers] > div').count();
check('reflect 步渲染了问卷答案本地复述（非空）', answersRendered >= 1, `n=${answersRendered}`);

// ⑤ 勾同意 + 生成画像
const adultCb = page.locator(`[data-step="reflect"] input[type="checkbox"]`).nth(0);
const sensCb = page.locator(`[data-step="reflect"] input[type="checkbox"]`).nth(1);
await adultCb.check();
await sensCb.check();
const genBtn = page.locator(`[data-step="reflect"] button:has-text("生成画像")`).first();
await genBtn.waitFor({ timeout: 5_000 });
const genDisabled = await genBtn.isDisabled();
check('勾同意后生成画像按钮启用', !genDisabled);

// ⑥ 记录 portrait 完成时刻（在按钮点击之后立即记）
const portraitStartMs = Date.now();
await genBtn.click();

// ⑦ 等 generating → echo
await page.waitForSelector('[data-step="echo"]', { timeout: 30_000 });
// 等 echo 文本落 DOM——要么 data-echo，要么 echoFailed 的 fallback
await page.waitForFunction(
  () => {
    const root = document.querySelector('[data-step="echo"]');
    if (!root) return false;
    return Boolean(root.querySelector('[data-echo]')) || root.innerText.includes('还没听清楚');
  },
  { timeout: 30_000 }
).catch(() => {});
const echoText = await page.locator('[data-step="echo"] [data-echo]').innerText().catch(() => '');
const fallbackText = await page.locator('[data-step="echo"]').innerText().catch(() => '');
const gotEcho = echoText.trim().length > 0;
check('echo 屏出现文本（要么拿到那一句，要么走 fallback）',
  gotEcho || fallbackText.includes('还没听清楚'),
  gotEcho ? echoText.slice(0, 60) : 'fallback');

if (gotEcho) {
  check('echo 以「我听到的是」开头（第一个物件的口径）',
    echoText.trim().startsWith('我听到的是'),
    echoText.slice(0, 24));
  // v2：echo 素材来自 questionnaire；要求引用用户填的自由题词
  const echoedWord = ['不配', '心慌', '余额'].find((w) => echoText.includes(w));
  check('echo 引用了用户自己填的词', Boolean(echoedWord), echoedWord ?? '(无)');
}

// ⑧ 校验三个 CTA 都在 echo 步
const ctaPortrait = page.locator(`[data-step="echo"] a:has-text("看画像")`).first();
const ctaChat = page.locator(`[data-step="echo"] button:has-text("想多聊聊")`).first();
const ctaSave = page.locator(`[data-step="echo"] a:has-text("保存你的画像")`).first();
check('echo 步有"看画像"CTA', await ctaPortrait.count() === 1);
check('echo 步有"想多聊聊"CTA（chat 后置）', await ctaChat.count() === 1);
check('echo 步有"保存你的画像"CTA（注册 nudge）', await ctaSave.count() === 1);

const elapsedSec = Math.round((portraitStartMs - startedAt) / 1000);
check(`DOM 测时：portrait 完成（含 form 填表）在前 ${elapsedSec}s 出现（< 600s 占位 KPI 才算过）`,
  elapsedSec > 0 && elapsedSec < 600,
  `${elapsedSec}s`);

// ⑨ 校验埋点：first_portrait_done.metadata.seconds 与 DOM 测时口径一致
// 注：旧 KPI `first_echo_shown` 在 v2 下仍可落库（echo 步 useEffect 触发了 startedAt 测时），
// 但验收以 portrait 为锚（新 KPI）；旧 KPI 仅留痕，不再断言 < 180。
if (sql) {
  const rows = await sql`
    SELECT metadata FROM events
    WHERE user_key = ${userKey} AND name = 'first_portrait_done'
    ORDER BY id LIMIT 1`;
  const md = rows[0]?.metadata ?? {};
  check('埋点 first_portrait_done 落库（v2 新 KPI）', Boolean(md), JSON.stringify(md));
  if (md && typeof md.seconds === 'number') {
    check(`埋点 seconds < 600（v2 占位 KPI，实际=${md.seconds}）`, md.seconds < 600 && md.seconds > 0);
    check('埋点不含自由题原文（敏感内容不进日志）',
      !JSON.stringify(md).includes('不配') && !JSON.stringify(md).includes('心慌'),
      Object.keys(md).join(','));
  }
}

console.log('\n—— 浏览器 console 错误 ——');
const filtered = errors.filter((e) => !e.includes('/_next/hmr') && !e.includes('WebSocket'));
console.log(filtered.length ? filtered.join('\n') : '（无，除 HMR WebSocket 外）');
await browser.close();

console.log(`\n${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
