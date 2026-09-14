'use client';

// 前台改造（70-2 B3）· 镜像卡：提交后展示用户原话 + 陪伴者一句 echo + 「想多说两句」门。
//
// - 顶部：你写的是「{firstLine || thought || 跳过了}」
// - 下方：陪伴者听到的是「{echo/receipt}」——这里 echo 直接用 /api/journey/close
//   返回的 receipt 字段（一句话回应），不另起路由。
// - 「想多说两句」门 → /chat?start=1&door=1[&quote=<encoded thought/firstLine>]
//   ChatView 的 auto-opener 会引用 memories 并接上 quote，行为上就是"AI 先开口"。
// - 「改一下」按钮回到 act 段（mirror 状态清空）。
import Link from 'next/link';
import type { Dict } from '@/i18n/get-dict';
import styles from './MirrorCard.module.css';

interface MirrorPayload {
  did: 'done' | 'partial' | 'missed';
  thought: string;
  firstLine: string;
  firstLineSkipped: boolean;
  receipt: string | null;
}

interface Props {
  locale: string;
  dict: Dict;
  mirror: MirrorPayload;
  onEdit: () => void;
}

export default function MirrorCard({ locale, dict, mirror, onEdit }: Props) {
  const t = dict.newJourney;
  const userWrote = mirror.firstLine.trim() || mirror.thought.trim();
  const echo = mirror.receipt ?? t.mirrorEchoFallback;

  // 门的 quote：用户原话或 thought；都没有就空（fallback 由 CompanionDoor 顶）
  const doorQuote = encodeURIComponent(userWrote);
  const doorHref = userWrote
    ? `/${locale}/chat?start=1&door=1&quote=${doorQuote}`
    : `/${locale}/chat?start=1&door=1`;

  return (
    <article className={styles.card} data-step="done">
      <p className={styles.eyebrow}>{t.doneEyebrow}</p>

      <section className={styles.block}>
        <p className={styles.blockLabel}>{t.mirrorQuote}</p>
        {userWrote ? (
          <blockquote className={styles.quote}>
            「{userWrote}」
          </blockquote>
        ) : (
          <p className={styles.skipped}>{t.noMirror}</p>
        )}
      </section>

      <section className={styles.block}>
        <p className={styles.blockLabel}>{t.mirrorEcho}</p>
        <p className={styles.echo}>{echo}</p>
      </section>

      <footer className={styles.footer}>
        <Link href={doorHref} className={styles.door} data-companion-door-link="">
          {dict.companion.doorLink} →
        </Link>
        <button type="button" onClick={onEdit} className={styles.edit}>
          改一下
        </button>
      </footer>

      <p className={styles.doneSub}>{t.doneSub}</p>
    </article>
  );
}