// 6 节点验收读数（docs/10 P0-2 §2.2）。
//
// 只干一件事：把 `events(name='node_verdict')` 里的实际值打印出来。
// **不算达标线，不判通过与否** —— `20-1` 里那几个阈值（≥70%/≥60%/≥40%/1.5×、反指标 30%）
// 全是推断、无出处（docs/10 已登记），第一轮的任务是拿到实际分布，好把阈值回填成真的。
// 一个脚本自己发明一条及格线，比没有及格线更糟：它会把"跑过了"变成"合格了"。
//
// 逻辑在 `/api/touch/verdicts`，这里只是薄壳：读取端是 TS，纯 Node 引不了 `.ts`
// （见那条路由的文件头）。换成 cron / 手动 curl 读同一份数据也不用改业务。
//
// 用法：
//   node --env-file=.env.local scripts/verify-nodes.mjs                 # 全体分布
//   node --env-file=.env.local scripts/verify-nodes.mjs --user u:<uuid> # 单个用户明细
//   node --env-file=.env.local scripts/verify-nodes.mjs --json          # 机器可读
const BASE = process.env.TOUCH_BASE_URL ?? process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000';
const secret = process.env.TOUCH_CRON_SECRET;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
};
const userKey = flag('user');
const asJson = args.includes('--json');

if (!secret) {
  console.error('[nodes] TOUCH_CRON_SECRET 未配置 —— 端点不会开门');
  process.exit(1);
}

const res = await fetch(`${BASE}/api/touch/verdicts`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-touch-secret': secret },
  body: JSON.stringify({ ...(userKey ? { userKey } : {}) }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`[nodes] HTTP ${res.status}`, body.error ?? '');
  process.exit(1);
}

const rows = body.rows ?? [];
const nodeOrder = body.nodes ?? [];
const summary = body.summary ?? null;

if (asJson) {
  console.log(JSON.stringify({ rows, summary }, null, 2));
  process.exit(0);
}

// user_key 是匿名 ID、不是 PII，但也没必要整串进 journal：读数只需要"能对上同一个人"，
// 前 4 后 4 够用（`--user` 是照原串查的，遮的只是打印）。
const mask = (key) => key.replace(/^(.{4}).*(.{4})$/, '$1…$2');

console.log(`[nodes] events(name='node_verdict') 共 ${rows.length} 条${userKey ? `（user=${userKey}）` : ''}`);

if (rows.length === 0) {
  // 空库也是一种读数：它说明"还没有人走到节点"，不说明"节点坏了"。
  // 要区分这两件事，得先看有没有人走到节点日——那是另一个问题，这一行不替它下结论。
  console.log('[nodes] 库里还没有任何节点答卷。先造一个走到节点日的用户（或改 created_at）。');
  process.exit(0);
}

// ── 分布（全体口径）：每行一个节点，看的是实际比例，不是合不合格 ──
// 节点清单由端点回（`VERDICT_NODES`），不在这里抄一份：抄了就会漂，
// 而漂掉的后果是"加了新节点但读数的表里没有它"——表看着照样完整。
const byNode = new Map();
for (const r of rows) {
  const slot = byNode.get(r.node) ?? { total: 0, yes: 0, no: 0, pending: 0, behavior: 0, cognition: 0, byTouch: 0 };
  slot.total += 1;
  slot[r.verdict] += 1;
  if (r.behaviorOk) slot.behavior += 1;
  if (r.cognitionOk) slot.cognition += 1;
  if (r.source === 'touch') slot.byTouch += 1;
  byNode.set(r.node, slot);
}

const pct = (n, d) => (d === 0 ? '-' : `${Math.round((n / d) * 100)}%`);
console.log('');
console.log('节点   答卷  成立  不成立  待续  |  行为达标  认知达标  |  信叫回来');
for (const node of nodeOrder) {
  const s = byNode.get(node);
  if (!s) {
    console.log(`${node.padEnd(6)}   0      -      -      -  |      -         -     |     -`);
    continue;
  }
  console.log(
    `${node.padEnd(6)} ${String(s.total).padStart(4)}  ${pct(s.yes, s.total).padStart(5)} ${pct(s.no, s.total).padStart(5)} ${pct(s.pending, s.total).padStart(5)}  |  ` +
      `${pct(s.behavior, s.total).padStart(5)}     ${pct(s.cognition, s.total).padStart(5)}   |  ${String(s.byTouch).padStart(4)}`
  );
}

// ── 每人一行：整轮走到哪、读出什么 ──
// 全体分布回答"这条路对人群成不成立"，按人看回答"这个人走到哪了"。两个问题分开打印，
// 因为把一个人的三态读成整轮的结论，正是这套验证最容易犯的错。三态现算（端点按人算），
// 不落库——阈值改了立刻生效，改的是读法不是历史数据。
const users = new Map();
for (const r of rows) {
  const list = users.get(r.userKey) ?? [];
  list.push(r);
  users.set(r.userKey, list);
}

if (summary === null) {
  // 全体口径下端点不回 summary ——"全体三态"不是个有意义的东西：三态是「这个人这条路
  // 当下通不通」，把一群人的三态合成一个值，只会得到一个谁都不是的答案。
  console.log('');
  console.log(`按人看（${users.size} 人）：`);
  for (const [key, list] of users) {
    const last = list[list.length - 1];
    const seq = list.map((r) => `${r.node}:${r.verdict}`).join(' ');
    console.log(`  ${mask(key)}  答卷=${list.length}  最近=${last.node}:${last.verdict}  序列=[${seq}]`);
  }
  console.log('');
  console.log('[nodes] 要看某个人的整轮读数（最远/三态/首次达标/收官未回答）：');
  console.log('[nodes]   node --env-file=.env.local scripts/verify-nodes.mjs --user u:<uuid>');
} else {
  // 单人口径：整轮读数。只列这一人，不打印别人的行——推理过程不夹带无关数据。
  const key = summary.answered[0]?.userKey ?? userKey;
  console.log('');
  console.log(
    `${mask(key)}  最远=${summary.furthest ?? '-'}  三态=${summary.state}  ` +
      `首次达标=${summary.convergedAtNode ? `第 ${summary.convergedAtNode} 个节点` : '未出现'}`
  );
  console.log(`  答卷序列=[${summary.answered.map((r) => `${r.node}:${r.verdict}`).join(' ')}]`);
  // 提前收官的"没回答什么"：收官是对整轮下结论，漏掉没答的那几个问题，
  // 结论会读起来比实际更大。所以这行必须跟着 `no` 一起出现，不能等他来问。
  if (summary.unanswered.length > 0) {
    console.log(`  收官未回答：${summary.unanswered.join('；')}`);
  }
  // 依据指针：不打印原话（原话在 threads 里，导出/删号已覆盖），只打印能不能回溯
  for (const r of summary.answered) {
    if (r.basisAt || r.basisTopic) {
      console.log(`  ${r.node} 依据指针 topic=${r.basisTopic ?? '-'} at=${r.basisAt ?? '-'}（照此可回 threads 取原话）`);
    }
  }
}

console.log('');
console.log('[nodes] 以上全是实际值。达标线待定——不要在此脚本里加阈值判定。');
