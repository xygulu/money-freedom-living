import { Pool } from 'pg';
import { betterAuth } from 'better-auth';
import { username } from 'better-auth/plugins';
import { hashPassword, verifyPassword } from './password';
import { validateUsername } from './validation';
import { getDbProviders } from '@/config/db-providers';
import { sendResendEmail } from './email-resend';

/**
 * 认证：Better Auth（https://better-auth.com）。
 * - 数据库走 pg Pool（TCP 连 Neon pooled 连接串），表 user/session/account/verification
 *   由 scripts/schema-migrate.mjs 管理；业务表（订阅/权益/配额）走
 *   @neondatabase/serverless 的 HTTP 驱动，见 lib/db.ts
 * - 本文件内部一律用相对导入：better-auth CLI（jiti）加载本配置时
 *   不保证能解析 tsconfig 的 @/ 路径别名
 *
 * Failover（已知妥协）：模块加载期从 getDbProviders() 取首项 URL 建 Pool。
 * 首项不可用 → 进程起不来（better-auth Pool 与运行时 session 强耦合，
 * 运行时切换会破坏现有登录态；业务表那边才做运行时 failover）。
 */

/** 应用名：进邮件主题。按项目改，或设 APP_NAME 环境变量 */
const APP_NAME = process.env.APP_NAME ?? 'App';
/** 邮箱验证链接点完后的回跳地址（#hash 不会被 better-auth 的 URL 解析吞掉） */
const EMAIL_VERIFIED_HASH = '/#email-verified';

const dbProviders = getDbProviders();
if (dbProviders.length === 0) {
  throw new Error('未配置任何 DB 连接串（设置 DATABASE_URL 或 DATABASE_URL_FALLBACK）');
}
const authDbUrl = dbProviders[0].url;

const pool = new Pool({
  connectionString: authDbUrl,
  // Neon 空闲会挂起断连：控制池大小并主动回收空闲连接，Kysely 层会自动重建
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export const auth = betterAuth({
  database: pool,
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  user: {
    // 启用 /api/auth/change-email：新邮箱先收验证链接，点了才切换
    //（旧邮箱在此之前仍生效，避免改到一半丢号）
    changeEmail: {
      enabled: true,
      callbackURL: EMAIL_VERIFIED_HASH,
    },
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 6,
    // 邮箱验证不阻塞登录：发验证邮件但放行登录/使用；
    // 要对某能力设门槛，在该能力的 API 路由里判 session.user.emailVerified
    // 自定义 scrypt：Node 默认参数（N=16384/r=8/p=1）+ 16 字节盐，存储格式
    // salt:hash（见 lib/password.ts）。⚠️ better-auth 内置实现是 r=16 + NFKC，
    // 格式不兼容——只要项目用过别的 scrypt 存量数据就必须走自定义钩子
    password: {
      hash: (password) => hashPassword(password),
      verify: ({ hash, password }) => verifyPassword(hash, password),
    },
    // 重置密码：better-auth 校验通过后调此函数发邮件。
    // RESEND_API_KEY 未配时整段为 undefined、功能自动关闭（配置守门）
    sendResetPassword: process.env.RESEND_API_KEY
      ? async ({ user, url }) => {
          await sendResendEmail({
            to: user.email,
            subject: `${APP_NAME} - 重置密码`,
            text: `你（或别人）请求重置密码。点击以下链接 1 小时内有效：\n${url}\n\n如果不是本人操作请忽略。`,
            html: `<p>你（或别人）请求重置密码。</p><p><a href="${url}">点击重置密码</a>（1 小时内有效）</p><p>如果不是本人操作请忽略。</p>`,
          });
        }
      : undefined,
  },
  emailVerification: {
    // 注册时自动发验证邮件
    sendOnSignUp: true,
    // 登录时若未验证邮箱自动重发——无论用户从哪个入口登录，邮件都会送达
    sendOnSignIn: true,
    // ⚠️ better-auth 在 sign-up / sign-in / send-verification-email 三处
    // 优先从请求 body 读 callbackURL，body 没带时才落到这个 config；
    // 前端各发送处请显式传同款值兜底
    callbackURL: EMAIL_VERIFIED_HASH,
    sendVerificationEmail: process.env.RESEND_API_KEY
      ? async ({ user, url }) => {
          await sendResendEmail({
            to: user.email,
            subject: `欢迎来到 ${APP_NAME} - 验证邮箱`,
            text: `点击以下链接验证你的邮箱：\n${url}\n\n如果你没注册账号请忽略。`,
            html: `<p>点击以下链接验证你的邮箱：</p><p><a href="${url}">验证邮箱</a></p><p>如果你没注册账号请忽略。</p>`,
          });
        }
      : undefined,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 天
    updateAge: 60 * 60 * 24, // 每天滚动续期一次
  },
  // 社交登录：凭证缺失时整段不入列（不配置 = 按钮虽在但会 500；条件入列更稳）
  socialProviders: {
    google: process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? {
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        }
      : (undefined as never),
    github: process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
      ? {
          clientId: process.env.GITHUB_CLIENT_ID,
          clientSecret: process.env.GITHUB_CLIENT_SECRET,
        }
      : (undefined as never),
  },
  plugins: [
    username({
      minUsernameLength: 3,
      maxUsernameLength: 20,
      // 复用与表单一致的用户名规则（默认校验器不允许中文；见 lib/validation.ts）
      usernameValidator: (name) => validateUsername(name) === null,
    }),
  ],
});

export type Session = typeof auth.$Infer.Session;
