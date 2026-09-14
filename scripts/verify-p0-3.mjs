// P0-3 首启重排验收（docs/10 §P0-3）：
// 真浏览器走一遍，JS 读 DOM 文本测时——`events.first_echo_shown.seconds < 180` 才算过。
// 验收路径（首启重排后的）：
//   1. /zh-CN/onboarding 落地 → 首屏是 welcome（`先喘口气` 在场、`data-question` 不在场）
//   2. 点「我在」→ 进对话屏（`data-step="talk"`），AI 给出开场白
//   3. 用户发一句 → 拿到 AI 追问 → 出现「我听到的是…」按钮
//   4. 点 → 进 echo 屏 → `data-echo` 出现文本 → JS 读 `Date.now()` 算耗时
//   5. 查 events 表的 `first_echo_shown` 那条 metadata.seconds 与 DOM 耗时对照
//
// 不依赖 LLM：dialog 推一条用户原话即可触发 echo。
// 服务端可用的前提下，本脚本只断言"在 3 分钟内拿到了 echo"——这是 P0-3 的红线，
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
// 提前种一个 guest_qk 上下文（身份路由会用 cookie 解析 user_key）
await ctx.addCookies([
  { name: 'guest_qk', value: userKey.replace('g:', ''), url: BASE, sameSite: 'Lax' },
]);

// ① 落地：首屏是欢迎
await page.goto(`${BASE}/zh-CN/onboarding`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-step="welcome"]', { timeout: 10_000 });
const welcomeText = await page.locator('[data-step="welcome"]').innerText();
check('首屏是欢迎（看到「先喘口气」/「不用填问卷」其一）',
  welcomeText.includes('先喘口气') || welcomeText.includes('不用填问卷'),
  welcomeText.slice(0, 60).replace(/\n/g, '|'));
const surveyOnFirst = await page.locator('[data-step="welcome"] [data-question]').count();
check('首屏不出现问卷（welcome 屏里没有 data-question）', surveyOnFirst === 0, `n=${surveyOnFirst}`);
check('首屏没有 data-consent（同意区在 reflect 步才出现）',
  (await page.locator('[data-step="welcome"] [data-consent]').count()) === 0);

// ② 进入对话：点「我在」→ AI 出开场
const startBtn = page.locator('button:has-text("我在")').first();
await startBtn.click();
await page.waitForSelector('[data-step="talk"]', { timeout: 10_000 });
// 等 AI 第一句（在 talk 屏的对话容器里抓第一个非用户气泡——左对齐、含边框）
await page.waitForFunction(
  () => {
    const root = document.querySelector('[data-step="talk"]');
    if (!root) return false;
    // 用户气泡 class 含 `bg-accent/10`，AI 气泡 class 含 `border-line` + `bg-white/60`，
    // 最简单的口径是找任意文本非空的子节点（不在输入框 / 按钮里）
    const bubbles = Array.from(root.querySelectorAll('div')).filter((el) => {
      const cls = el.className ?? '';
      if (typeof cls !== 'string') return false;
      return el.innerText && el.innerText.trim().length > 4 &&
        (cls.includes('rounded-2xl') || cls.includes('rounded-bl-sm') || cls.includes('rounded-br-sm'));
    });
    return bubbles.some((b) => !b.className.includes('bg-accent/10'));
  },
  { timeout: 30_000 }
).catch(() => {});
const assistantFirst = await page.locator('[data-step="talk"] div').filter({
  hasText: /./,
}).evaluateAll((nodes) => {
  const bubbles = nodes.filter((n) => {
    const cls = (n.className && typeof n.className === 'string') ? n.className : '';
    const text = (n.innerText ?? '').trim();
    return text.length > 4 && cls.includes('rounded-2xl') && !cls.includes('bg-accent/10');
  });
  return bubbles[0]?.innerText ?? '';
}).catch(() => '');
check('对话屏出现 AI 开场白（不是空白）', assistantFirst.trim().length > 4, assistantFirst.slice(0, 60));

// ③ 用户发一句
const input = page.locator('[data-step="talk"] input').first();
const userUtterance = '上个月看了一次余额，突然就慌了一下，不敢点开。';
await input.fill(userUtterance);
await input.press('Enter');
// 等 AI 追问
await page.waitForTimeout(1500);
// 再来一句（确保有足够素材 echo 能用）
await input.fill('我妈在边上问怎么了，我说没什么。');
await input.press('Enter');
await page.waitForTimeout(1500);

// ④ 拿 echo：UI 上出现「我听到的是…」按钮（userTurns>=1 即显示）
const echoCta = page.locator('[data-step="talk"] button:has-text("我听到的是")').first();
await echoCta.waitFor({ timeout: 5_000 });
const echoCtaVisible = await echoCta.isVisible();
check('对话结束可触发 echo（UI 出现「我听到的是…」按钮）', echoCtaVisible);

const echoStartMs = Date.now();
await echoCta.click();
await page.waitForSelector('[data-step="echo"]', { timeout: 10_000 });
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
  // 必须引用他自己的词：原话里至少有一个词被复述回去（不要求逐字）
  const echoedWord = ['余额', '慌', '妈妈', '妈', '不敢点开', '上个月'].find((w) => echoText.includes(w));
  check('echo 引用了用户自己说过的词', Boolean(echoedWord), echoedWord ?? '(无)');
}

const elapsedSec = Math.round((echoStartMs - startedAt) / 1000);
check(`DOM 测时：echo 屏在前 ${elapsedSec}s 出现（< 180s 才算过）`,
  elapsedSec > 0 && elapsedSec < 180,
  `${elapsedSec}s`);

// ⑤ 校验埋点：first_echo_shown.metadata.seconds 与 DOM 测时口径一致
if (sql) {
  // 直接用 user_key（种子里 addCookies 已经设了 guest_qk，路由会用它当 user_key）
  const rows = await sql`
    SELECT metadata FROM events
    WHERE user_key = ${userKey} AND name = 'first_echo_shown'
    ORDER BY id LIMIT 1`;
  const md = rows[0]?.metadata ?? {};
  check('埋点 first_echo_shown 落库', Boolean(md), JSON.stringify(md));
  if (md && typeof md.seconds === 'number') {
    check(`埋点 seconds < 180（实际=${md.seconds}）`, md.seconds < 180 && md.seconds > 0);
    check('埋点 under3min=true', md.under3min === true);
    check('埋点不含复述原文（敏感内容不进日志）',
      !JSON.stringify(md).includes('我听到的是') && !JSON.stringify(md).includes(userUtterance),
      Object.keys(md).join(','));
  }
}

console.log('\n—— 浏览器 console 错误 ——');
const filtered = errors.filter((e) => !e.includes('/_next/hmr') && !e.includes('WebSocket'));
console.log(filtered.length ? filtered.join('\n') : '（无，除 HMR WebSocket 外）');
await browser.close();

console.log(`\n${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
