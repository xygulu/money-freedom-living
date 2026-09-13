'use client';

// 真实记录表单（用户指令：行动按钮的去处——记录实际发生的行为/事件/场景与
// 感受，而不是通用聊天）。实际发生了什么（必填）+ 一句感受（可空），与微行动
// 同一管线：POST /api/journey/experiment → 安全层、收条（LLM 即时见证）、
// 活跃足迹、进评估素材——评估的依据从这里来，评估结论才立得住。
// saved 后停在现场（收条常驻），不弹走。灯图灯行（StageLampChart）与行动
// 列表（ActionRecordList）共用。
import { useState } from 'react';
import type { Dict } from '@/i18n/get-dict';

export default function RecordForm({
  locale,
  dict,
  anchor,
  onDone,
}: {
  locale: string;
  dict: Dict;
  anchor?: string; // 行动锚点（来自评估的某条行动）：表单标题行显示这条行动是什么
  onDone: () => void; // 保存成功后收起表单（收条留在原地）
}) {
  const t = dict.journey;
  const [what, setWhat] = useState('');
  const [feeling, setFeeling] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [receipt, setReceipt] = useState<string | null>(null);
  const [showSafety, setShowSafety] = useState(false);

  async function submit() {
    if (state !== 'idle' || !what.trim()) return;
    setState('saving');
    try {
      const res = await fetch('/api/journey/experiment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: what.trim(), feeling: feeling.trim() || undefined, locale }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { safety?: boolean; receipt?: string | null };
      setShowSafety(data.safety === true);
      setReceipt(typeof data.receipt === 'string' && data.receipt ? data.receipt : null);
      setState('saved');
      onDone();
    } catch {
      // 失败保留输入，回到可提交状态
      setState('idle');
    }
  }

  if (state === 'saved') {
    return (
      <div className="mt-2" data-record-saved>
        <p className="text-sm text-ink-soft">{t.microSaved}</p>
        {receipt && <p className="mt-2 text-sm leading-relaxed">{receipt}</p>}
        {showSafety && <p className="mt-2 text-sm leading-relaxed text-ink-soft">{dict.chat.safetyNote}</p>}
      </div>
    );
  }

  return (
    <div className="mt-2" data-record-form>
      {anchor && (
        <p className="mb-2 text-xs leading-relaxed text-ink-soft/70">{t.recordAnchor.replace('{action}', anchor)}</p>
      )}
      <label className="text-xs text-ink-soft" htmlFor="record-what">
        {t.recordWhatLabel}
      </label>
      <textarea
        id="record-what"
        value={what}
        onChange={(e) => setWhat(e.target.value)}
        placeholder={t.recordWhatPlaceholder}
        rows={2}
        maxLength={300}
        className="mt-1 w-full resize-none border border-line bg-white/60 p-3 text-sm leading-relaxed outline-none focus:border-ink"
      />
      <label className="mt-2 block text-xs text-ink-soft" htmlFor="record-feeling">
        {t.microFeelingPlaceholder}
      </label>
      <textarea
        id="record-feeling"
        value={feeling}
        onChange={(e) => setFeeling(e.target.value)}
        rows={2}
        maxLength={500}
        className="mt-1 w-full resize-none border border-line bg-white/60 p-3 text-sm leading-relaxed outline-none focus:border-ink"
      />
      <button
        onClick={submit}
        disabled={state === 'saving' || !what.trim()}
        className="mt-3 border border-ink px-4 py-2 text-sm transition-colors hover:bg-ink hover:text-paper disabled:opacity-50"
      >
        {state === 'saving' ? '…' : t.microSave}
      </button>
    </div>
  );
}
