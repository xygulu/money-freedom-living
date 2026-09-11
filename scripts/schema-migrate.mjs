// Better Auth schema 迁移（程序化）。
// 运行：node --env-file=.env.local scripts/schema-migrate.mjs
//
// 为什么不用 `pnpm dlx @better-auth/cli migrate`：
// CLI 包发布滞后（最新 1.4.x），生成的 account 表缺 1.7.x 运行时需要的
// issuer 等列。getMigrations 直接用项目安装的 better-auth 计算 diff，版本永远一致。
// 幂等：只创建缺失的表/列，可安全重跑。新库部署顺序：先跑本脚本，再起应用。
import { Pool } from 'pg';
import { betterAuth } from 'better-auth';
import { username } from 'better-auth/plugins';
import { getMigrations } from '../node_modules/better-auth/dist/db/get-migration.mjs'; // 1.7.2 未从包入口导出，走文件路径绕过 exports map

// 与 src/lib/auth.ts 保持一致（仅 schema 相关项：plugins / 模型配置；
// 密码钩子 / sendResetPassword / sendVerificationEmail 等纯函数不影响表结构，无需在此复制）
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const auth = betterAuth({
  database: pool,
  emailAndPassword: {
    enabled: true,
    // 仅占位：getMigrations 不调用此函数，只是让 schema-migrate 与运行时 auth 字段定义对齐
    sendResetPassword: async () => {},
  },
  emailVerification: {
    sendVerificationEmail: async () => {},
  },
  plugins: [
    username({
      minUsernameLength: 3,
      maxUsernameLength: 20,
    }),
  ],
});

const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options, {
  // 已有数据的表加 NOT NULL 列时允许继续（迁移器会把列建为可空），缺失值随后补
  throwOnUnsafe: false,
});

if (toBeCreated.length === 0 && toBeAdded.length === 0) {
  console.log('schema 已是最新，无需迁移');
} else {
  console.log('将创建的表:', toBeCreated.map((t) => t.table).join(', ') || '(无)');
  console.log('将补充的列:', toBeAdded.map((t) => t.table).join(', ') || '(无)');
  await runMigrations();
  console.log('迁移完成 ✅');
}
await pool.end();
