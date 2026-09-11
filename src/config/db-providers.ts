// DB 供应商配置：按顺序返回当前可用的 DB 连接串列表。
// 调用层（lib/db.ts / lib/auth.ts）按顺序逐个试，任一失败立即切下一个。
//
// 设计原则：
// - 配置层只读 env 拼 URL，不实例化 client、不缓存
// - 第 1 项永远是当前在用的 DATABASE_URL（Neon pooled）
// - 第 2 项优先读 DATABASE_URL_FALLBACK；未填时自动落 DATABASE_URL_UNPOOLED
//   （neon link 通常已把它写进 .env.local，因此"无需新配置即生效"）
// - 已知限制：同一 Neon project 的 pooled/unpooled 故障相关性高
//   （区域级故障时两条一起挂）；要真正异机容灾就填 DATABASE_URL_FALLBACK 指向另一个 project
// - auth 只取首项 URL 建 Pool（模块加载期锁定，见 lib/auth.ts 的注释）

export interface DbProvider {
  id: string;
  /** Neon Postgres 连接串 */
  url: string;
  label: string;
}

export function getDbProviders(): DbProvider[] {
  const list: DbProvider[] = [];

  if (process.env.DATABASE_URL) {
    list.push({
      id: 'primary',
      url: process.env.DATABASE_URL,
      label: 'Neon pooled',
    });
  }

  // 第 2 项：FALLBACK 优先，否则自动用 UNPOOLED（无需新配置即生效）
  if (process.env.DATABASE_URL_FALLBACK) {
    list.push({
      id: 'fallback',
      url: process.env.DATABASE_URL_FALLBACK,
      label: 'Neon fallback',
    });
  } else if (process.env.DATABASE_URL_UNPOOLED) {
    list.push({
      id: 'unpooled',
      url: process.env.DATABASE_URL_UNPOOLED,
      label: 'Neon unpooled',
    });
  }

  // 第 3 项：再备用。按需填 DATABASE_URL_3 即可启用
  if (process.env.DATABASE_URL_3) {
    list.push({
      id: 'db-3',
      url: process.env.DATABASE_URL_3,
      label: '备用 DB 1',
    });
  }

  return list;
}
