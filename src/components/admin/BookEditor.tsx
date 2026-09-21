'use client';

// 书工作台（V0.2 C4）：贴素材 → AI 起草 → 人工逐项校正 → 保存。
// 状态是整份 AdminBookState，整存整取（单人后台工具，不做协作编辑）。
// 内容质量不在这里拦——发布闸（build-content）是硬闸，这里只管把源文件改对。
import { useState } from 'react';
import type { AdminBookState, AdminDailyCard, AdminLamp, AdminStage } from '@/lib/admin-content';

const TOPICS: Array<{ id: string; zh: string }> = [
  { id: 'self-worth', zh: '我不配' },
  { id: 'parents', zh: '和父母的关系' },
  { id: 'inner-turmoil', zh: '情绪与内耗' },
  { id: 'boundaries', zh: '关系与边界' },
  { id: 'money-safety', zh: '金钱与安全感' },
  { id: 'allowing', zh: '允许自己' },
];
const LANGS: Array<{ id: string; zh: string }> = [
  { id: 'en', zh: 'English' },
  { id: 'zh-CN', zh: '简体中文' },
  { id: 'zh-TW', zh: '繁體中文' },
  { id: 'ja', zh: '日本語' },
];

const inputCls = 'w-full border border-line bg-white px-2 py-1.5 text-sm';
const labelCls = 'block text-xs text-ink-soft';
const boxCls = 'border border-line bg-white/60 p-4';
const DAILY_TYPES = ['observation', 'practice', 'way'] as const;

function LinesField({ label, value, onChange, rows = 3 }: { label: string; value: string[]; onChange: (v: string[]) => void; rows?: number }) {
  return (
    <label className="block">
      <span className={labelCls}>{label}（一行一条）</span>
      <textarea className={inputCls} rows={rows} value={value.join('\n')} onChange={(e) => onChange(e.target.value.split('\n'))} />
    </label>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className={labelCls}>{label}</span>
      <input className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function StageForm({ stage, onChange }: { stage: AdminStage; onChange: (patch: Partial<AdminStage>) => void }) {
  return (
    <div className="mt-2 flex flex-col gap-2 border-l-2 border-line pl-3">
      <div className="flex gap-2">
        <label className="w-20">
          <span className={labelCls}>段号</span>
          <input className={inputCls} type="number" min={1} value={stage.id} onChange={(e) => onChange({ id: Number(e.target.value) })} />
        </label>
        <label className="flex-1">
          <span className={labelCls}>段短名（进度栏显示）</span>
          <input className={inputCls} value={stage.title} onChange={(e) => onChange({ title: e.target.value })} />
        </label>
        <label className="w-24">
          <span className={labelCls}>周数</span>
          <input className={inputCls} type="number" min={1} value={stage.weeks} onChange={(e) => onChange({ weeks: Number(e.target.value) })} />
        </label>
      </div>
      <TextField label="这一段带读者看见什么（goal，会进评估标尺）" value={stage.goal} onChange={(v) => onChange({ goal: v })} />
      <LinesField label="练习（exercises）" value={stage.exercises} onChange={(v) => onChange({ exercises: v })} />
      <LinesField label="陪伴者该做（ai_stance.do）" value={stage.do} onChange={(v) => onChange({ do: v })} />
      <LinesField label="陪伴者不该做（ai_stance.dont）" value={stage.dont} onChange={(v) => onChange({ dont: v })} />
      <LinesField label="走完标志（advance_when，程度句式）" value={stage.advance_when} onChange={(v) => onChange({ advance_when: v })} />
      <TextField label="仪式（ritual）" value={stage.ritual} onChange={(v) => onChange({ ritual: v })} />
      <TextField label="0 元替代版（free_alt，可空）" value={stage.free_alt} onChange={(v) => onChange({ free_alt: v })} />
      <div>
        <span className={labelCls}>命题标签（topics）</span>
        <div className="mt-1 flex flex-wrap gap-3">
          {TOPICS.map((t) => (
            <label key={t.id} className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={stage.topics.includes(t.id)}
                onChange={(e) =>
                  onChange({ topics: e.target.checked ? [...stage.topics, t.id] : stage.topics.filter((x) => x !== t.id) })
                }
              />
              {t.zh}
            </label>
          ))}
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={stage.skippable === true} onChange={(e) => onChange({ skippable: e.target.checked })} />
        可跳过（skippable）
      </label>
      <label className="block">
        <span className={labelCls}>正文（body，给读者与 AI 上下文，发布闸要求 ≥100 字符）</span>
        <textarea className={inputCls} rows={8} value={stage.body} onChange={(e) => onChange({ body: e.target.value })} />
      </label>
    </div>
  );
}

function LampForm({ lamp, onChange }: { lamp: AdminLamp; onChange: (patch: Partial<AdminLamp>) => void }) {
  return (
    <div className="mt-2 flex flex-col gap-2 border-l-2 border-line pl-3">
      <div className="flex gap-2">
        <label className="flex-1">
          <span className={labelCls}>kind（须带书前缀，跨书唯一）</span>
          <input className={inputCls} value={lamp.kind} onChange={(e) => onChange({ kind: e.target.value })} />
        </label>
        <label className="w-40">
          <span className={labelCls}>命题</span>
          <select className={inputCls} value={lamp.topic} onChange={(e) => onChange({ topic: e.target.value })}>
            {TOPICS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.zh}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-end gap-1 pb-1 text-xs">
          <input type="checkbox" checked={lamp.needsAction} onChange={(e) => onChange({ needsAction: e.target.checked })} />
          需行为证据
        </label>
      </div>
      <TextField label="promptHint（评估 LLM 的内部判定提示，中文程度句式）" value={lamp.promptHint} onChange={(v) => onChange({ promptHint: v })} />
      <div className="grid grid-cols-2 gap-2">
        {LANGS.map((l) => (
          <TextField key={l.id} label={`灯名 ${l.zh}（label）`} value={lamp.label[l.id] ?? ''} onChange={(v) => onChange({ label: { ...lamp.label, [l.id]: v } })} />
        ))}
        {LANGS.map((l) => (
          <TextField key={`h-${l.id}`} label={`标准 ${l.zh}（hint）`} value={lamp.hint[l.id] ?? ''} onChange={(v) => onChange({ hint: { ...lamp.hint, [l.id]: v } })} />
        ))}
      </div>
    </div>
  );
}

function CardForm({ card, onChange }: { card: AdminDailyCard; onChange: (patch: Partial<AdminDailyCard>) => void }) {
  return (
    <div className="mt-2 flex flex-col gap-2 border-l-2 border-line pl-3">
      <label className="block">
        <span className={labelCls}>正文（text，一句话 ≤40 字）</span>
        <textarea className={inputCls} rows={2} value={card.text} onChange={(e) => onChange({ text: e.target.value })} />
      </label>
      <label className="block">
        <span className={labelCls}>反思提问（reflection，开放式，不问是非题）</span>
        <textarea className={inputCls} rows={2} value={card.reflection} onChange={(e) => onChange({ reflection: e.target.value })} />
      </label>
      <div className="flex flex-wrap items-end gap-4">
        <label>
          <span className={labelCls}>type</span>
          <select className={`${inputCls} w-36`} value={card.type} onChange={(e) => onChange({ type: e.target.value })}>
            {DAILY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <div>
          <span className={labelCls}>stages（可挂 1-2 段）</span>
          <div className="mt-1 flex gap-3">
            {[1, 2, 3, 4].map((s) => (
              <label key={s} className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={card.stages.includes(s)}
                  onChange={(e) => onChange({ stages: e.target.checked ? [...card.stages, s] : card.stages.filter((x) => x !== s) })}
                />
                段 {s}
              </label>
            ))}
          </div>
        </div>
        <div>
          <span className={labelCls}>topics（1-2 个，发布闸硬拦缺失）</span>
          <div className="mt-1 flex flex-wrap gap-3">
            {TOPICS.map((t) => (
              <label key={t.id} className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={card.topics.includes(t.id)}
                  onChange={(e) =>
                    onChange({ topics: e.target.checked ? [...card.topics, t.id] : card.topics.filter((x) => x !== t.id) })
                  }
                />
                {t.zh}
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function BookEditor({ bookId, initial }: { bookId: string; initial: AdminBookState }) {
  const [state, setState] = useState<AdminBookState>(initial);
  const [busy, setBusy] = useState<'draft' | 'save' | 'tag' | null>(null);
  const [log, setLog] = useState<{ ok: boolean; text: string } | null>(null);

  const patchMeta = (patch: Partial<AdminBookState['meta']>) => setState((s) => ({ ...s, meta: { ...s.meta, ...patch } }));
  const patchStage = (locale: string, index: number, patch: Partial<AdminStage>) =>
    setState((s) => ({
      ...s,
      journey: { ...s.journey, [locale]: s.journey[locale].map((st, i) => (i === index ? { ...st, ...patch } : st)) },
    }));
  const patchLamp = (stageKey: string, index: number, patch: Partial<AdminLamp>) =>
    setState((s) => ({
      ...s,
      lamps: { ...s.lamps, [stageKey]: (s.lamps[stageKey] ?? []).map((lp, i) => (i === index ? { ...lp, ...patch } : lp)) },
    }));
  const patchCard = (locale: 'zh-CN' | 'en', index: number, patch: Partial<AdminDailyCard>) =>
    setState((s) => ({
      ...s,
      daily: { ...s.daily, [locale]: s.daily[locale].map((c, i) => (i === index ? { ...c, ...patch } : c)) },
    }));

  async function save(): Promise<void> {
    setBusy('save');
    setLog(null);
    try {
      const res = await fetch(`/api/admin/books/${bookId}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state }),
      });
      const data = (await res.json()) as { ok: boolean; log?: string[] };
      setLog({ ok: Boolean(data.ok), text: data.ok ? '已保存到 content/ 源文件。' : (data.log ?? ['保存失败']).join('\n') });
    } catch {
      setLog({ ok: false, text: '网络错误，没存上' });
    }
    setBusy(null);
  }

  async function draft(kind: 'journey' | 'daily'): Promise<void> {
    setBusy('draft');
    setLog(null);
    try {
      const res = await fetch('/api/admin/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId, source: state.source, kind }), // 素材随请求先落盘，免得忘保存
      });
      const data = (await res.json()) as { ok: boolean; log?: string[]; state?: AdminBookState };
      if (data.ok && data.state) setState(data.state); // 草稿只覆盖对应区块，本地其他编辑不动
      setLog({ ok: Boolean(data.ok), text: data.ok ? (data.log ?? []).join('\n') : (data.log ?? ['起草失败']).join('\n') });
    } catch {
      setLog({ ok: false, text: '网络错误，起草没跑成' });
    }
    setBusy(null);
  }

  // 存量批量打标：只补缺 topics 的条目（一签两池 + practices），已校正过的不动
  async function tag(): Promise<void> {
    setBusy('tag');
    setLog(null);
    try {
      const res = await fetch('/api/admin/tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId }),
      });
      const data = (await res.json()) as { ok: boolean; log?: string[]; state?: AdminBookState };
      if (data.ok && data.state) setState(data.state);
      setLog({ ok: Boolean(data.ok), text: data.ok ? (data.log ?? []).join('\n') : (data.log ?? ['打标失败']).join('\n') });
    } catch {
      setLog({ ok: false, text: '网络错误，打标没跑成' });
    }
    setBusy(null);
  }

  const lampStages = Object.keys(state.lamps).sort((a, b) => Number(a) - Number(b));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-medium">《{state.meta.title['zh-CN'] || bookId}》</h1>
        <span className="text-xs text-ink-soft">{bookId}</span>
        <span className="border border-line px-2 py-0.5 text-xs text-ink-soft">{state.meta.status === 'active' ? '已发布' : '草稿'}</span>
        <a href="/admin" className="ml-auto text-xs text-ink-soft underline underline-offset-2">
          ← 返回书列表
        </a>
      </div>

      <div className={boxCls}>
        <h2 className="text-sm">素材（给 AI 起草用：书的摘录 / 要点 / 你的转述）</h2>
        <textarea className={`${inputCls} mt-2`} rows={10} value={state.source} onChange={(e) => setState((s) => ({ ...s, source: e.target.value }))} />
      </div>

      <div className={boxCls}>
        <h2 className="text-sm">书信息（meta.md）</h2>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {LANGS.map((l) => (
            <TextField key={l.id} label={`书名 ${l.zh}`} value={state.meta.title[l.id] ?? ''} onChange={(v) => patchMeta({ title: { ...state.meta.title, [l.id]: v } })} />
          ))}
          <TextField label="作者" value={state.meta.author} onChange={(v) => patchMeta({ author: v })} />
          <TextField label="出处（版本/出版社/年份）" value={state.meta.source} onChange={(v) => patchMeta({ source: v })} />
        </div>
        <div className="mt-2">
          <span className={labelCls}>覆盖命题（topics）</span>
          <div className="mt-1 flex flex-wrap gap-3">
            {TOPICS.map((t) => (
              <label key={t.id} className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={state.meta.topics.includes(t.id)}
                  onChange={(e) =>
                    patchMeta({ topics: e.target.checked ? [...state.meta.topics, t.id] : state.meta.topics.filter((x) => x !== t.id) })
                  }
                />
                {t.zh}
              </label>
            ))}
          </div>
        </div>
        <label className="mt-2 flex items-center gap-2 text-xs">
          <span>status：</span>
          <select className="border border-line bg-white px-2 py-1 text-xs" value={state.meta.status} onChange={(e) => patchMeta({ status: e.target.value as 'draft' | 'active' })}>
            <option value="draft">draft（不上线）</option>
            <option value="active">active（发布时上线，过发布闸）</option>
          </select>
        </label>
        <label className="mt-2 block">
          <span className={labelCls}>一句话：这本书给读者的是什么（meta 正文）</span>
          <textarea className={inputCls} rows={2} value={state.meta.note} onChange={(e) => patchMeta({ note: e.target.value })} />
        </label>
      </div>

      <div className={boxCls}>
        <h2 className="text-sm">AI 起草（覆盖现有内容，写回源文件）</h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-soft/70">
          每次校验不过自动重试一次；草稿写回源文件。{state.meta.status === 'active' && (
            <strong className="ml-1">这本书是 active：AI 不许覆盖线上内容，起草被拒（打标不受限）。</strong>
          )}
        </p>
        <div className="mt-3 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => void draft('journey')}
            disabled={busy !== null}
            className="border border-ink px-5 py-2 text-sm transition-colors hover:bg-ink hover:text-paper disabled:opacity-50"
          >
            {busy === 'draft' ? '正在起草……约 1-3 分钟' : 'AI 起草 journey + 灯表'}
          </button>
          <button
            type="button"
            onClick={() => void draft('daily')}
            disabled={busy !== null}
            className="border border-ink px-5 py-2 text-sm transition-colors hover:bg-ink hover:text-paper disabled:opacity-50"
          >
            {busy === 'draft' ? '正在起草……' : 'AI 起草一签池（覆盖两池 ≥90 条，约 2-4 分钟）'}
          </button>
        </div>
      </div>

      <div className={boxCls}>
        <h2 className="text-sm">journey 校正</h2>
        {(['zh-CN', 'en'] as const).map((locale) => (
          <div key={locale} className="mt-3">
            <h3 className="text-xs tracking-widest text-ink-soft">{locale}</h3>
            {state.journey[locale]?.length ? (
              state.journey[locale].map((st, i) => (
                <details key={st.file} className="mt-1" open={locale === 'zh-CN'}>
                  <summary className="cursor-pointer text-sm">
                    段 {st.id} · {st.title || <span className="text-ink-soft/60">（无标题）</span>}
                  </summary>
                  <StageForm stage={st} onChange={(patch) => patchStage(locale, i, patch)} />
                </details>
              ))
            ) : (
              <p className="mt-1 text-xs text-ink-soft">还没有段——点上面「AI 起草」。</p>
            )}
          </div>
        ))}
      </div>

      <div className={boxCls}>
        <h2 className="text-sm">灯表校正</h2>
        {lampStages.length ? (
          lampStages.map((key) => (
            <div key={key} className="mt-3">
              <h3 className="text-xs tracking-widest text-ink-soft">段 {key}（{state.lamps[key].length} 盏）</h3>
              {state.lamps[key].map((lp, i) => (
                <details key={`${lp.kind}-${i}`} className="mt-1">
                  <summary className="cursor-pointer text-sm">{lp.label['zh-CN'] || lp.kind || '（未命名灯）'}</summary>
                  <LampForm lamp={lp} onChange={(patch) => patchLamp(key, i, patch)} />
                </details>
              ))}
            </div>
          ))
        ) : (
          <p className="mt-1 text-xs text-ink-soft">还没有灯——点上面「AI 起草」。</p>
        )}
      </div>

      <div className={boxCls}>
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="text-sm">一签池（每日一签，发布闸要求 ≥90 条 + 每条 1-2 个命题标签）</h2>
          <button
            type="button"
            onClick={() => void tag()}
            disabled={busy !== null}
            className="border border-line px-3 py-1 text-xs transition-colors hover:bg-ink hover:text-paper disabled:opacity-50"
          >
            {busy === 'tag' ? '正在打标……' : 'AI 批量打标（只补缺 topics：两池 + practices）'}
          </button>
        </div>
        {(['zh-CN', 'en'] as const).map((locale) => {
          const pool = state.daily[locale] ?? [];
          const missing = pool.filter((c) => c.topics.length === 0).length;
          return (
            <div key={locale} className="mt-4">
              <h3 className="text-xs tracking-widest text-ink-soft">
                {locale}（{pool.length} 条{missing > 0 ? `，缺 topics ${missing} 条` : '，标签齐'}）
              </h3>
              {pool.length ? (
                pool.map((c, i) => (
                  <details key={i} className="mt-1">
                    <summary className="cursor-pointer text-sm">
                      <span className="mr-2 text-xs text-ink-soft">
                        #{i + 1} {c.type} · 段{c.stages.join('/')} · {c.topics.length ? c.topics.join('/') : <span className="text-red-500">缺标</span>}
                      </span>
                      {c.text.slice(0, 24)}
                      {c.text.length > 24 ? '……' : ''}
                    </summary>
                    <CardForm card={c} onChange={(patch) => patchCard(locale, i, patch)} />
                  </details>
                ))
              ) : (
                <p className="mt-1 text-xs text-ink-soft">还没有一签——点上面「AI 起草一签池」。</p>
              )}
            </div>
          );
        })}
      </div>

      <div className={boxCls}>
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy !== null}
          className="border border-ink px-5 py-2 text-sm transition-colors hover:bg-ink hover:text-paper disabled:opacity-50"
        >
          {busy === 'save' ? '正在保存……' : '保存全部到源文件'}
        </button>
        <p className="mt-2 text-xs text-ink-soft/70">保存后到 <a href="/admin" className="underline underline-offset-2">书列表页</a> 点「重新编译并发布」推上线（发布闸会硬校验）。</p>
        {log && (
          <pre
            data-admin-log={log.ok ? 'ok' : 'failed'}
            className={`mt-3 max-h-64 overflow-auto border px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap ${
              log.ok ? 'border-line text-ink-soft' : 'border-red-300 text-red-700'
            }`}
          >
            {log.text}
          </pre>
        )}
      </div>
    </div>
  );
}
