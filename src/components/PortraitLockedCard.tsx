// 画像 partial 锁卡：访客访问 /portrait 时，AI 推断的两段（"我听到的可能" +
// "给未来的你"）替换为这张卡片。访客需要看清"这是被锁的内容"——
// 不是内容变模糊。轻微边框 + 居中文案 + 一句 CTA。
//
// 用户 2026-09-14 拍板：访客看画像①②③（自己说话的素材），④⑤上锁引导注册。
import Link from 'next/link';
import type { Dict } from '@/i18n/get-dict';

interface Props {
  dict: Dict;
  section: 'script' | 'toFuture';
  lockedHref: string;
}

export default function PortraitLockedCard({ dict, section, lockedHref }: Props) {
  const data = dict.portrait.locked[section];
  return (
    <article
      data-portrait-locked
      data-locked-section={section}
      className="rounded-2xl border border-line bg-paper px-6 py-8 text-center"
    >
      <p className="text-xs uppercase tracking-widest text-ink-soft">{data.eyebrow}</p>
      <p className="mt-4 text-2xl leading-snug font-medium tracking-tight text-ink">
        {data.title}
      </p>
      <p className="mt-4 whitespace-pre-line text-base leading-relaxed text-ink-soft">
        {data.body}
      </p>
      <Link
        href={lockedHref}
        data-portrait-locked-cta
        className="mt-8 inline-block rounded-full bg-accent px-6 py-3 text-sm text-paper transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ink"
      >
        {dict.portrait.locked.cta} →
      </Link>
    </article>
  );
}