// 一次性修复：该用户的 stamps 在 14:39-14:44（旧渲染补发印代码窗口期）被灌入
// 834 条重复；appendStamps 的空清单早退 bug 让自愈没跑。这里执行与 appendStamps
// 完全相同的去重 SQL（DISTINCT ON kind 留首现，earnedAt 保留最早）。
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const key = 'u:nQhJClQUNLij2nTCMexN8avxV4ufgLc4';
const before = (await sql`SELECT jsonb_array_length(stamps) AS n FROM growth_profiles WHERE user_key = ${key}`)[0].n;
await sql`UPDATE growth_profiles
    SET stamps = (
          SELECT coalesce(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
          FROM (
            SELECT DISTINCT ON (e->>'kind') e AS elem, ord
            FROM jsonb_array_elements(stamps) WITH ORDINALITY AS t(e, ord)
            ORDER BY e->>'kind', ord
          ) first_per_kind
        )
    WHERE user_key = ${key}`;
const row = (await sql`SELECT stamps FROM growth_profiles WHERE user_key = ${key}`)[0];
console.log(`stamps：${before} → ${row.stamps.length}`);
console.log(row.stamps.map((s) => `${s.kind}@${String(s.earnedAt).slice(0, 19)}`).join('\n'));
