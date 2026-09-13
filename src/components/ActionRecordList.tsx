'use client';

// 评估行动 → 真实记录列表（用户指令：下一步的按钮不跳通用聊天，而是去记录
// 实际发生的行为/事件/场景与感受）。每条行动一个按钮，点开就地展开记录表单
// （RecordForm）。写入 experiments——与微行动同一管线（安全层、收条、活跃
// 足迹、进评估素材）。灯图（StageLampChart）与阶段 4 页内块（无灯不画图时）
// 共用本组件。
import { useState } from 'react';
import type { Dict } from '@/i18n/get-dict';
import RecordForm from '@/components/RecordForm';

export default function ActionRecordList({
  locale,
  dict,
  actions,
  label,
}: {
  locale: string;
  dict: Dict;
  actions: string[];
  label: string; // 区块标题（assess.actionsLabel），调用方给
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  if (actions.length === 0) return null;
  return (
    <div>
      <p className="text-xs tracking-widest text-ink-soft">{label}</p>
      <div className="mt-3 flex flex-col gap-2">
        {actions.map((a, i) => (
          <div key={i} data-action-cta={String(i)}>
            {openIndex === i ? (
              <RecordForm locale={locale} dict={dict} anchor={a} onDone={() => setOpenIndex(null)} />
            ) : (
              <button
                type="button"
                onClick={() => setOpenIndex(i)}
                className="flex w-full items-center justify-between gap-3 border border-ink px-4 py-2.5 text-left text-sm leading-relaxed transition-colors hover:bg-ink hover:text-paper"
              >
                <span>{a}</span>
                <span aria-hidden>→</span>
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
