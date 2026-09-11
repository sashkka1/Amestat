"use client";

import { AtSignIcon } from "lucide-react";
import { fmtNum } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { CrossInfo } from "@/lib/cross";
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

// Три числа в колонке комментариев страницы «Amestat Test» (владелец, 2026-09-11): «20 · 15 · 3» —
// снято текстов, из них не авторских, из них от других наших креаторов. Отдельной колонки
// «Перекрёстно» больше нет: третье число живёт здесь же, рядом со своими знаменателями.
//
// 🔴 Первое число — СНЯТЫЕ тексты (`comments_total`), а не счётчик площадки из снимка: иначе
// «20 · 15 · 3» врало бы, потому что 15 и 3 считаются только по прочитанному. Счётчик площадки
// уходит в подсказку отдельной строкой — он обычно больше, и путать их нельзя.
//
// Текстов не снимали вовсе — прочерк, а не «0 · 0 · 0»: ноль тут значил бы «проверили и не
// нашли», а мы не проверяли.
export function CrossCounts({
  info,
  // Счётчик комментариев из последнего снимка видео; null — снимка нет.
  platformTotal,
}: {
  info: CrossInfo | undefined;
  platformTotal: number | null;
}) {
  const t = useT();
  if (!info || info.total <= 0) {
    return <span className="text-muted-foreground/50">—</span>;
  }
  // Свои комментарии не могут превысить снятые, но арифметика базы и снимок приходят порознь —
  // отрицательное число в колонке было бы хуже нуля.
  const others = Math.max(0, info.total - info.self);
  const lines = [
    t("cross.countsTotal", { n: fmtNum(info.total) }),
    t("cross.countsOthers", { n: fmtNum(others), self: fmtNum(info.self) }),
    info.handles.length > 0
      ? t("cross.countsCrossWho", {
          n: fmtNum(info.cross),
          handles: info.handles.map((h) => `@${h}`).join(", "),
        })
      : t("cross.countsCross", { n: fmtNum(info.cross) }),
  ];
  if (platformTotal !== null) lines.push(t("cross.countsPlatform", { n: fmtNum(platformTotal) }));
  return (
    <span className="inline-flex items-center gap-1 tabular-nums" title={lines.join("\n")}>
      <span>{fmtNum(info.total)}</span>
      <Sep />
      <span>{fmtNum(others)}</span>
      <Sep />
      <span
        className={
          info.cross > 0
            ? "font-medium text-amber-600 dark:text-amber-500"
            : "text-muted-foreground/60"
        }
      >
        {fmtNum(info.cross)}
      </span>
    </span>
  );
}

// Разделитель чисел: тонкая черта цвета `border` — она не спорит с цифрами и темнеет вместе
// с остальными линиями таблицы.
function Sep() {
  return <span aria-hidden className="h-3 w-px shrink-0 bg-border" />;
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
