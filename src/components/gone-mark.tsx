"use client";

import { Trash2Icon } from "lucide-react";
import { fmtDayAxis } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// 🔴 Единственная отметка «похоже, удалено с площадки» на сайте (миграция v33, владелец
// 2026-09-17): затемнение и значок, «которые чётко дают понять, что данный креатор был удалён
// или данное видео было удалено». Компонент один нарочно — как `creator-label.tsx`: строки,
// карточки и шапки обязаны помечать удалённое одинаково, иначе через месяц половина мест
// покажет что-нибудь своё.
//
// ⚠️ Отметку ставит и снимает СБОРЩИК, `gone_at` — дата ПЕРВОГО подозрения, а не приговор:
// видео нашлось снова — колонка гаснет. На статистику отметка не влияет вовсе: удалённое
// считается как считалось.

// Затемнение — двух видов, и это не прихоть. Картинка (обложка, аватар) гаснет серым и
// вполсилы. Строка таблицы — только вполсилы: CSS-фильтр родителя потомок снять не может, и
// `grayscale` на строке обесцветил бы саму пилюлю — значок терял бы красный, ради которого
// он и стоит. Числа в строке при этом остаются читаемыми.
export const GONE_IMAGE_CLASS = "opacity-50 grayscale";
export const GONE_ROW_CLASS = "opacity-60";

function goneTitle(at: string, kind: Kind, t: ReturnType<typeof useT>): string {
  const date = fmtDayAxis(at);
  return kind === "video" ? t("gone.videoTitle", { date }) : t("gone.creatorTitle", { date });
}

type Kind = "video" | "creator";

// Пилюля рядом с подписью: в строке таблицы, поверх обложки, возле имени креатора.
export function GoneBadge({
  at,
  kind,
  className,
}: {
  // null — отметки нет, и рисовать нечего.
  at: string | null;
  kind: Kind;
  className?: string;
}) {
  const t = useT();
  if (at === null) return null;
  return (
    <span
      title={goneTitle(at, kind, t)}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px]",
        "border-destructive/40 bg-destructive/10 text-destructive",
        className,
      )}
    >
      <Trash2Icon className="size-3" />
      {kind === "video" ? t("gone.video") : t("gone.creator")}
    </span>
  );
}

// Та же мысль строкой — для шапок, где место есть и пилюля мелка: панель видео и шапка
// креатора. Текст один и тот же, что в подсказке пилюли.
export function GoneLine({ at, kind }: { at: string | null; kind: Kind }) {
  const t = useT();
  if (at === null) return null;
  return <p className="text-xs text-destructive">{goneTitle(at, kind, t)}</p>;
}
