// 时间线节点渲染（server 纯展示，无状态无交互）。每种源一种观感：
// 心印是仪式时刻——点亮样式；封存的信只留痕不给正文；
// 链接只指向真实存在的目的地（对话回看 / 画像版本）。
import Link from 'next/link';
import type { Dict } from '@/i18n/get-dict';
import type { TimelineItem } from '@/lib/timeline';

/** 心印 kind → 展示名。未知 kind（未来新增）回落原始键，绝不渲染空白 */
function stampName(dict: Dict, kind: string): string {
  return (dict.stamps as unknown as Record<string, string>)[kind] ?? kind;
}

export default function TimelineItemView({
  item,
  locale,
  dict,
}: {
  item: TimelineItem;
  locale: string;
  dict: Dict;
}) {
  return (
    <div className="border-l-2 border-accent/50 pl-4">
      {item.kind === 'stamp' && (
        <>
          <p className="text-sm leading-relaxed text-accent">● {stampName(dict, item.stampKind)}</p>
          <p className="mt-1 text-xs text-ink-soft">{dict.timeline.kindStamp}</p>
        </>
      )}

      {item.kind === 'memory' && (
        <>
          <p className="text-xs tracking-widest text-ink-soft">{dict.timeline.kindMemory}</p>
          <p className="mt-2 text-sm leading-relaxed">{item.text}</p>
          {item.sessionId && (
            <Link
              href={`/${locale}/chat/history/${item.sessionId}`}
              className="mt-2 inline-block text-accent underline underline-offset-4"
            >
              {dict.timeline.viewTalk} →
            </Link>
          )}
        </>
      )}

      {item.kind === 'journal' && (
        <>
          <p className="text-xs tracking-widest text-ink-soft">{dict.timeline.kindJournal}</p>
          <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap">{item.text}</p>
        </>
      )}

      {item.kind === 'letter' && (
        <>
          <p className="text-xs tracking-widest text-ink-soft">
            {dict.timeline.kindLetter} · {dict.letters.stateLabel[item.state]}
          </p>
          {item.text ? (
            <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap">{item.text}</p>
          ) : (
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">{dict.timeline.sealedLetter}</p>
          )}
        </>
      )}

      {item.kind === 'experiment' && (
        <>
          <p className="text-xs tracking-widest text-ink-soft">{dict.timeline.kindExperiment}</p>
          <p className="mt-2 text-sm leading-relaxed">{item.action}</p>
          {item.feeling && (
            <p className="mt-1 text-sm leading-relaxed text-ink-soft">
              {dict.timeline.experimentFeeling}：{item.feeling}
            </p>
          )}
        </>
      )}

      {item.kind === 'portrait' && (
        <>
          <p className="text-xs tracking-widest text-ink-soft">
            {dict.timeline.kindPortrait} v{item.version}
          </p>
          {item.current ? (
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">{dict.timeline.portraitCurrent}</p>
          ) : null}
          <Link
            href={item.current ? `/${locale}/portrait` : `/${locale}/portrait?version=${item.version}`}
            className="mt-2 inline-block text-accent underline underline-offset-4"
          >
            {dict.timeline.viewPortrait} →
          </Link>
        </>
      )}
    </div>
  );
}
