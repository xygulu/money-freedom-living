import { getDict } from '@/i18n/get-dict';

export default async function mePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const dict = getDict(locale);

  return (
    <div className="pt-20 text-center">
      <h1 className="text-xl">{dict.placeholder.title}</h1>
      <p className="mt-4 text-ink-soft">{dict.placeholder.body}</p>
    </div>
  );
}
