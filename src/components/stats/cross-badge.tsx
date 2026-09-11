"use client";

import { AtSignIcon } from "lucide-react";
import { fmtNum } from "@/lib/format";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// Жёлтая метка перекрёстности: «(3)» рядом с числом комментариев. Владелец, 2026-09-11:
// «у видео 5 комментариев, а рядом жёлтым (1) — один из них от другого нашего креатора».
//
// Жёлтый тот же, что у состояния «смотрим» (`lib/video-state.ts`): на этом сайте жёлтое
// всегда значит «обрати внимание», и заводить второй такой цвет незачем.
//
// Подсказка — обычный `title`: своего Tooltip у проекта нет, а сказать надо ровно одну
// строку. Ноль перекрёстных — метки нет вовсе: «(0)» у каждой строки превратило бы таблицу
// в шум.
export function CrossBadge({
  n,
  handles,
  className,
}: {
  n: number;
  // Кто оставил эти комментарии: имена без «@», различные.
  handles: string[];
  className?: string;
}) {
  const t = useT();
  if (n <= 0) return null;
  return (
    <span
      className={cn("font-medium tabular-nums text-amber-600 dark:text-amber-500", className)}
      title={
        handles.length > 0
          ? t("cross.badgeTitle", {
              n: fmtNum(n),
              handles: handles.map((h) => `@${h}`).join(", "),
            })
          : t("cross.badgeTitleNoNames", { n: fmtNum(n) })
      }
    >
      ({fmtNum(n)})
    </span>
  );
}

// Значок «@»: нашего креатора назвали в подписи ролика. Стоит рядом с числами и говорит
// о другом виде пересечения — без комментария, но с упоминанием.
export function MentionMark({ handles, className }: { handles: string[]; className?: string }) {
  const t = useT();
  if (handles.length === 0) return null;
  // Подпись одна на `title` и на `aria-label`: значок без слов не читается ни мышью,
  // ни голосом.
  const text = t("cross.mentionTitle", { handles: handles.map((h) => `@${h}`).join(", ") });
  return (
    <span className={cn("inline-flex", className)} title={text} aria-label={text} role="img">
      <AtSignIcon className="size-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
    </span>
  );
}
