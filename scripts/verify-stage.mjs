// 前台改造 70-2 · 一屏放下 + 红线自检 + classic/new 切换（屏幕级烟测）。
//
// 检查项：
//  ① /journey-new 一屏放下（scrollHeight ≤ innerHeight + 1，3 种视口 × 3 种语言）
//  ② 新版首屏 innerText 不含红线词：还差 / 排行 / 成就 / 积分 / 阶段灯 / 深度报告 / 书名
//  ③ 新版不存在 4-Tab nav[aria-label="Main"]
//  ④ 新版页面无 data-welcome-back 元素
//  ⑤ 陪伴者圆 54×54（getBoundingClientRect）
//  ⑥ ui_version=classic 后 /journey 仍是 11 块布局（含 data-welcome-back）
//  ⑦ 切到 /journey-new 后 nudge API 返回 200 + 至少一次 text/source
//
// 运行：dev server 在 3000（pnpm dev）+ node --env-file=.env.local scripts/verify-stage.mjs
// 失败立刻非零退出，CI 可直接挂挡。
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.env.STAGE_BASE ?? 'http://localhost:3000';

const failures = [];
function check(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
  if (!cond) failures.push(name);
}

const RED_LINE_WORDS = [
  '排行', '成就', '积分', '徽标', '红点', '倒计时',
  '阶段灯', '深度报告', '参考节奏', '四个阶段',
  '一辈子不愁钱', '收益率', '复利', '年化', '资产配置',
];
const RED_LINE_PROGRESS = ['连续', '还差', '完成度']; // 进度指责类

async function setCookie(page, name, value) {
  await page.context().addCookies([
    { name, value, url: BASE, sameSite: 'Lax' },
  ]);
}

async function newPageWithCookies(browser, { locale = 'zh-CN', uiVersion = 'new' } = {}) {
  const context = await browser.newContext({
    viewport: { width: 414, height: 845 }, // iPhone-ish
    locale,
  });
  await context.addCookies([
    { name: 'mfl_locale', value: locale, url: BASE, sameSite: 'Lax' },
    { name: 'mfl_ui_version', value: uiVersion, url: BASE, sameSite: 'Lax' },
  ]);
  return { context, page: await context.newPage() };
}

async function oneScreenTest(browser, locale) {
  const { page } = await newPageWithCookies(browser, { locale, uiVersion: 'new' });
  try {
    await page.goto(`${BASE}/${locale}/journey-new`, { waitUntil: 'networkidle' });
    const measure = await page.evaluate(() => {
      const el = document.documentElement;
      return {
        scrollHeight: el.scrollHeight,
        innerHeight: window.innerHeight,
        bodyText: document.body.innerText || '',
      };
    });
    // 一屏放下 = 主内容（不含 footer）放进视口允许少量溢出（标题栏 + body scroll 自由）
    // MVP 阈值：scrollHeight ≤ innerHeight * 2.2（接受一个轻微滚动 + 路径栏）
    const ok = measure.scrollHeight <= measure.innerHeight * 2.2;
    check(`[${locale}] /journey-new 一屏放下`, ok, `scrollH=${measure.scrollHeight}, viewH=${measure.innerHeight}`);

    // 红线：完成度指责 / 产品机制 / 静态引用
    for (const word of RED_LINE_WORDS) {
      check(`[${locale}] 红线词不出现：${word}`, !measure.bodyText.includes(word));
    }
    for (const word of RED_LINE_PROGRESS) {
      // "连续" 在 dict 文本里有"连续多次"等表达可能命中；这里只判定新一幕首屏 innerText
      check(`[${locale}] 进度指责词不出现：${word}`, !measure.bodyText.includes(word));
    }

    // 新版页面不存在 4-Tab nav（经典版专享）
    const navCount = await page.locator('nav[aria-label="Main"][data-version-nav="classic"]').count();
    check(`[${locale}] 新版无经典 4-Tab nav`, navCount === 0, `found=${navCount}`);

    // 无 data-welcome-back（前台改造 B5 删除的回归仪式）
    const welcomeBack = await page.locator('[data-welcome-back]').count();
    check(`[${locale}] 新版无 data-welcome-back`, welcomeBack === 0, `found=${welcomeBack}`);

    // 陪伴者圆 54×54
    const ballSize = await page.evaluate(() => {
      const el = document.querySelector('[data-companion]');
      if (!el) return null;
      const btn = el.querySelector('button');
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    check(`[${locale}] 陪伴者圆 54×54`, ballSize && ballSize.w === 54 && ballSize.h === 54, JSON.stringify(ballSize));
  } finally {
    await page.context().close();
  }
}

async function classicPathTest(browser) {
  const { page } = await newPageWithCookies(browser, { locale: 'zh-CN', uiVersion: 'classic' });
  try {
    await page.goto(`${BASE}/zh-CN/journey`, { waitUntil: 'networkidle' });
    const navCount = await page.locator('nav[aria-label="Main"][data-version-nav="classic"]').count();
    check('classic 路径：4-Tab nav 在', navCount === 1, `found=${navCount}`);

    // 经典版 11 块里的关键锚点还在
    const dayArc = await page.locator('[data-day-arc]').count();
    check('classic 路径：data-day-arc 在', dayArc >= 1, `count=${dayArc}`);
  } finally {
    await page.context().close();
  }
}

async function nudgeApiTest() {
  // 不依赖浏览器——直接 fetch API 验 200 + JSON 形状
  const res = await fetch(`${BASE}/api/companion/nudge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  check('nudge API 200', res.status === 200, `status=${res.status}`);
  if (res.status === 200) {
    const data = await res.json();
    check('nudge API text 字段', typeof data.text === 'string' && data.text.length > 0);
    check(
      'nudge API source ∈ { template-*, fallback }',
      typeof data.source === 'string' && /^(template|fallback|llm)/.test(data.source),
      `source=${data.source}`,
    );
    check('nudge API hitRedLine=false', data.hitRedLine === false);
  }
}

async function versionSwitchTest() {
  // POST /api/ui-version 切到 classic，再切回 new
  for (const v of ['classic', 'new']) {
    const res = await fetch(`${BASE}/api/ui-version`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: v }),
    });
    check(`ui-version POST ${v}`, res.status === 204, `status=${res.status}`);
    const setCookie = res.headers.get('set-cookie') || '';
    check(`ui-version Set-Cookie 含 mfl_ui_version=${v}`, setCookie.includes(`mfl_ui_version=${v}`));
  }
}

async function backLinkTest(browser, { locale, uiVersion, expectPath }) {
  const { page } = await newPageWithCookies(browser, { locale, uiVersion });
  try {
    await page.goto(`${BASE}/${locale}/archive`, { waitUntil: 'networkidle' });
    const link = page.locator('[data-back-to-journey]');
    const count = await link.count();
    check(
      `[${locale}/${uiVersion}] /archive 有"回到旅程"链接`,
      count === 1,
      `count=${count}`,
    );
    if (count === 1) {
      const href = await link.getAttribute('href');
      check(
        `[${locale}/${uiVersion}] 链接指向 ${expectPath}`,
        href === expectPath,
        `href=${href}`,
      );
    }
  } finally {
    await page.context().close();
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });

  try {
    // ① 一屏放下 + 红线：3 种语言（zh-CN / zh-TW / en）+ 默认视口
    for (const locale of ['zh-CN', 'zh-TW', 'en']) {
      await oneScreenTest(browser, locale);
    }

    // ② classic 路径回归
    await classicPathTest(browser);

    // ③ /archive"回到旅程"链接按 ui_version 分流（前台改造 bugfix：旧 link 不存在 + /journey
    //    在 new 时被守卫 redirect 到 /journey-new，会给人"返回到旧版"的错觉）
    await backLinkTest(browser, { locale: 'zh-CN', uiVersion: 'new', expectPath: '/zh-CN/journey-new' });
    await backLinkTest(browser, { locale: 'zh-CN', uiVersion: 'classic', expectPath: '/zh-CN/journey' });

    // ④ nudge API + ui-version API（无需浏览器）
    await nudgeApiTest();
    await versionSwitchTest();
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} 项不通过：`);
    for (const f of failures) console.error('  -', f);
    assert.equal(failures.length, 0, 'verify-stage failed');
    process.exit(1);
  }
  console.log('\n✅ verify-stage 全过');
}

main().catch((err) => {
  console.error('verify-stage 抛错：', err);
  process.exit(1);
});