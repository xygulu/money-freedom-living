// 机制仪表（2026-09-24 批 1c）：验证期漏斗一页看全。
// 数据全部来自 events / growth_profiles 的只读聚合（src/lib/metrics.ts），零新表零新采集。
// 鉴权继承 admin/layout.tsx 的 currentAdmin 闸（非管理员 404）。
// 铁律：只呈现分布，不做任何"达标/未达标"判定（verdicts.ts 同款纪律——阈值等
// 第一轮实测分布出来再回填，20-1 判定表的口径）。
import Link from 'next/link';
import { getMechanismSnapshot, type MechanismSnapshot } from '@/lib/metrics';

export const dynamic = 'force-dynamic';

const pct = (r: number | null): string => (r === null ? '—' : `${(r * 100).toFixed(1)}%`);

const COGNITION_LABELS: Record<string, string> = {
  cognition_pause: 'L5 停一停（③写了且非"想不起来"）',
  cognition_regress: 'M 回退（AI 判回旧句式，用户不可见）',
  cognition_migrate_proposed: 'L4 迁移提议（AI 判新说法）',
  cognition_migrate_kept: 'L4 迁移确认（用户按了记下）',
  cognition_migrate_undone: 'L4 迁移撤销',
};

const ASSESS_LABELS: Record<string, string> = {
  first_echo_shown: '首启回声展示（"我听到的是…"）',
  stage_assessment_proposal_seen: '阶段评估提议首现',
  stage_assessment_confirmed: '阶段评估确认（灯就此落档）',
  stage_advanced: '阶段推进',
  evolve_proposal_seen: '画像演进提议首现',
  portrait_evolved: '画像重画完成',
};

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-line py-2 first:border-t-0">
      <span className="text-sm text-ink-soft">{label}</span>
      <span className="text-right">
        <span className="text-sm font-medium" data-metric={label}>{value}</span>
        {note && <span className="ml-2 text-xs text-ink-soft/70">{note}</span>}
      </span>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8 border border-line bg-white/60 p-4">
      <h2 className="text-sm">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export default async function AdminMetricsPage() {
  let snap: MechanismSnapshot | null = null;
  let error: string | null = null;
  try {
    snap = await getMechanismSnapshot();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <section>
      <h1 className="text-lg font-medium">机制仪表</h1>
      <p className="mt-2 text-xs leading-relaxed text-ink-soft">
        验证期漏斗只读视图（L1 做 → L2 说 → L3 续 → L4/L5/M → 评估 → 六节点）。
        只呈现分布、不做达标判定——阈值等第一轮实测分布回填（20-1 判定表口径）。
        数据源：events / growth_profiles 聚合，零新表。
      </p>

      {error && (
        <p className="mt-4 border border-line bg-white/60 p-4 text-sm text-red-700" data-metrics-error>
          查询失败：{error}
        </p>
      )}

      {snap && (
        <>
          <Card title="北极星：周完成 ≥3 步的用户占比（近 7 天）">
            <Row
              label="占比"
              value={pct(snap.northStar.ratio)}
              note={`${snap.northStar.achievedUsers} / ${snap.northStar.activeUsers} 人（分母 = 近 7 天交过 ≥1 格的人）`}
            />
            <Row label="近 30 天交过格的人" value={String(snap.close30d.closeUsers)} note={`共 ${snap.close30d.closeDays} 人日`} />
          </Card>

          <Card title="规模">
            <Row label="档案总数" value={String(snap.scale.profiles)} />
            <Row label="近 30 天新档案" value={String(snap.scale.new30d)} />
            <Row label="完成画像（累计去重）" value={String(snap.scale.withPortrait)} />
          </Card>

          <Card title="留存循环（近 30 天，按用户×天去重）">
            <Row label="L2 被看见率（交格当天也有对话）" value={pct(snap.seen30d.ratio)} note={`${snap.seen30d.seenDays} / ${snap.seen30d.closeDays} 人日`} />
            <Row label="L3 次日回来（交格次日有回访）" value={pct(snap.nextDay30d.ratio)} note={`${snap.nextDay30d.nextDays} / ${snap.nextDay30d.closeDays} 人日`} />
          </Card>

          <Card title="认知层（近 30 天）">
            {snap.cognition30d.map((c) => (
              <Row key={c.name} label={COGNITION_LABELS[c.name] ?? c.name} value={String(c.n)} note={`${c.users} 人`} />
            ))}
          </Card>

          <Card title="评估与画像演进（近 30 天）">
            {snap.assessment30d.map((a) => (
              <Row key={a.name} label={ASSESS_LABELS[a.name] ?? a.name} value={String(a.n)} />
            ))}
          </Card>

          <Card title="触达（近 180 天，per-node）">
            <Row label="总发出 / 回程" value={`${snap.touch.totalSent} / ${snap.touch.totalReturned}`} note={`拉回 ${pct(snap.touch.ratio)}`} />
            <table className="mt-3 w-full text-sm" data-metrics-touch>
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-soft">
                  <th className="py-1.5 pr-4 font-normal">节点</th>
                  <th className="py-1.5 pr-4 font-normal">发出</th>
                  <th className="py-1.5 pr-4 font-normal">回程</th>
                </tr>
              </thead>
              <tbody>
                {snap.touch.perNode.length === 0 && (
                  <tr><td colSpan={3} className="py-2 text-xs text-ink-soft">还没有发出记录</td></tr>
                )}
                {snap.touch.perNode.map((n) => (
                  <tr key={n.node} className="border-b border-line/50">
                    <td className="py-1.5 pr-4">{n.node}</td>
                    <td className="py-1.5 pr-4">{n.sent}</td>
                    <td className="py-1.5 pr-4">{n.returned}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="六节点答卷（三态分布）">
            <table className="mt-3 w-full text-sm" data-metrics-nodes>
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-soft">
                  <th className="py-1.5 pr-4 font-normal">节点</th>
                  <th className="py-1.5 pr-4 font-normal">yes</th>
                  <th className="py-1.5 pr-4 font-normal">no</th>
                  <th className="py-1.5 pr-4 font-normal">pending</th>
                  <th className="py-1.5 pr-4 font-normal">从信里回来</th>
                </tr>
              </thead>
              <tbody>
                {snap.nodes.map((n) => (
                  <tr key={n.node} className="border-b border-line/50">
                    <td className="py-1.5 pr-4">{n.node}</td>
                    <td className="py-1.5 pr-4">{n.yes}</td>
                    <td className="py-1.5 pr-4">{n.no}</td>
                    <td className="py-1.5 pr-4">{n.pending}</td>
                    <td className="py-1.5 pr-4">{n.fromTouch}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-xs leading-relaxed text-ink-soft/70">
              三态口径（docs/10 P0-2）：pending ≠ no——只有一层达标 = 机制空转，
              空转要靠下一个节点复现来坐实；不拿一个人一天的一句话收官整轮验证。
            </p>
          </Card>

          <p className="mt-8 border-t border-line pt-4 text-xs text-ink-soft">
            快照生成于 {snap.generatedAt} · <Link href="/admin" className="underline underline-offset-2">回到后台首页</Link>
          </p>
        </>
      )}
    </section>
  );
}
