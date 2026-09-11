// 用户报障复现：真浏览器（无头）走 体检选项点击 → chat CTA → 注册按钮。
// 验证干净加载（新会话）下前端交互是否全部正常——区分「代码 bug」vs「dev 重启 + HMR 断连导致旧页面变砖」。
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const errors = [];
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${String(e).slice(0, 300)}`));

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
  cond ? pass++ : fail++;
};

// ── 1. 体检：选项可点选 ──
await page.goto(`${BASE}/zh-CN/onboarding`, { waitUntil: 'networkidle' });
const step1 = page.locator('text=金钱关系体检').first();
check('体检页加载', await step1.isVisible().catch(() => false));

// 找问卷选项按钮（向导第一步：单选组）
const option = page.locator('button:has-text("周")').first();
const optionFallback = page.locator('[role="radio"], button').filter({ hasText: /工作日|周|发薪|月|每周|每月/ }).first();
const target = (await option.count()) ? option : optionFallback;
if (await target.count()) {
  await target.click();
  await page.waitForTimeout(300);
  const cls = (await target.getAttribute('class')) ?? '';
  const pressed = (await target.getAttribute('aria-pressed')) ?? '';
  const checked = (await target.getAttribute('aria-checked')) ?? '';
  check('体检选项点击后出现选中态', /accent|selected|ring|border-ink|bg-accent/.test(cls) || ['true'].includes(pressed) || ['true'].includes(checked), `class="${cls.slice(0, 80)}" aria-pressed=${pressed} aria-checked=${checked}`);
} else {
  check('体检选项点击后出现选中态', false, '未找到选项元素（需人工核对选择器）');
}

// ── 2. journey → chat CTA ──
await page.goto(`${BASE}/zh-CN/journey`, { waitUntil: 'networkidle' });
const cta = page.locator('a:has-text("开始今天的对话"), button:has-text("开始今天的对话")').first();
check('journey 有「开始今天的对话」入口', (await cta.count()) > 0);
if ((await cta.count()) > 0) {
  const href = await cta.getAttribute('href').catch(() => null);
  await cta.click();
  await page.waitForTimeout(1500);
  check('点击后进入 /chat', page.url().includes('/chat'), `href=${href} → ${page.url()}`);
}

// ── 3. 登录页：切注册模式 → 填表 → 注册按钮发出请求 ──
await page.goto(`${BASE}/zh-CN/login`, { waitUntil: 'networkidle' });
check('登录页表单渲染', (await page.locator('input').count()) >= 2, `inputs=${await page.locator('input').count()}`);
// 默认登录模式（2 框）；点第二个 button（type=button 的切换链接）进入注册模式（3 框）
await page.locator('form button[type="button"]').first().click();
await page.locator('#auth-username').waitFor({ timeout: 5000 });
const email = `pw-${Math.random().toString(36).slice(2, 8)}@smoke.test`;
// better-auth username 插件只允许字母数字下划线（连字符会 400 INVALID_USERNAME）
await page.locator('#auth-username').fill(`pw_${Math.random().toString(36).slice(2, 8)}`);
await page.locator('#auth-email').fill(email);
await page.locator('#auth-password').fill('playwright-pw-123');
const [resp] = await Promise.all([
  page.waitForResponse((r) => r.url().includes('/api/auth/') && r.request().method() === 'POST', { timeout: 15000 }).catch(() => null),
  page.locator('form button[type="submit"]').click(),
]);
check('注册按钮点击 → 请求发出', Boolean(resp), resp ? `${resp.request().url().split('/api/')[1]} → ${resp.status()}` : '无请求（按钮没反应）');
if (resp) {
  const okSignup = resp.status() === 200 || (await page.waitForURL('**/me', { timeout: 8000 }).then(() => true).catch(() => false));
  check('注册成功（200 / 跳转 /me）', okSignup, `status=${resp.status()} url=${page.url()}`);
}

console.log('\n—— 浏览器 console 错误 ——');
const filtered = errors.filter((e) => !e.includes('/_next/hmr') && !e.includes('WebSocket'));
console.log(filtered.length ? filtered.join('\n') : '（无，除 HMR WebSocket 外）');
await browser.close();
console.log(`\n${pass} 过 / ${fail} 败`);
process.exit(fail ? 1 : 0);
