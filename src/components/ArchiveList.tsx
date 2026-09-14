'use client';

// 前台改造（70-2 A3）· 聚合页列表。
// 只渲染链接到既有页面（不产生新数据，不调 LLM）。
import Link from 'next/link';
import styles from './ArchiveList.module.css';

interface Rows {
  trail: string;
  said: string;
  mirror: string;
  letter: string;
  write: string;
  setting: string;
}

export default function ArchiveList({
  locale,
  rows,
  writeHref,
}: {
  locale: string;
  rows: Rows;
  writeHref: string;
}) {
  const items: { label: string; href: string; kind: string }[] = [
    { label: rows.trail, href: `/${locale}/road`, kind: 'trail' },
    { label: rows.said, href: `/${locale}/chat/history`, kind: 'said' },
    { label: rows.mirror, href: `/${locale}/portrait`, kind: 'mirror' },
    { label: rows.letter, href: `/${locale}/letters`, kind: 'letter' },
    { label: rows.write, href: writeHref, kind: 'write' },
  ];

  return (
    <ul className={styles.list} data-archive-list>
      {items.map((it) => (
        <li key={it.kind} className={styles.row} data-archive-row={it.kind}>
          <Link href={it.href} className={styles.link}>
            <span className={styles.t}>{it.label}</span>
            <span className={styles.arrow}>›</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
