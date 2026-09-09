"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowLeftRightIcon } from "lucide-react";
import { PeriodChip } from "@/components/period-chip";
import { Button } from "@/components/ui/button";
import { SCOPES, scopeLabel, type Scope } from "@/lib/dashboard-prefs";
import { fmtDayLong, fmtDayYear } from "@/lib/format";
import { earliestSnapshotAt } from "@/lib/queries";
import { useT } from "@/lib/i18n";
import type { PeriodState } from "@/lib/use-period";
import { cn } from "@/lib/utils";

// Полоса под заголовком дашборда: чем ограничена вся страница по времени и по видео.
// Слева — та же пилюля срока, что стояла в шапке (она и так подписана датами границ),
// правее — сравнение с прошлым сроком и охват «Только наши / Все видео».
//
// ⚠️ Охват теперь считает база (миграция v22), поэтому прежней серой строки «часть блоков
// охвату не подчиняется» нет вовсе: подчиняются все.
//
// Осталась другая оговорка, и она про «Все видео»: счётчики есть только с первого обхода
// сборщика, а срок «Всё время» уходит к дате добавления креатора. Не сказать об этом —
// значит показать пустой хвост графика как провал.

// Тост про глубину истории — один раз за сессию: переключаться туда-сюда можно много раз,
// и повторять одно и то же на каждое нажатие незачем.
const TOAST_KEY = "amestat.allVideosNoteShown";

function shownThisSession(): boolean {
  try {
    return window.sessionStorage.getItem(TOAST_KEY) === "1";
  } catch {
    // Хранилища нет — считаем, что не показывали: лишний тост безобиднее пропавшего.
    return false;
  }
}

function markShown(): void {
  try {
    window.sessionStorage.setItem(TOAST_KEY, "1");
  } catch {
    // Не сохранилось — тост повторится в следующий раз. Ломать из-за этого нечего.
  }
}

// Дней от самого раннего снимка до сегодня, включительно: снимок сегодня — это «1 дн.»,
// вчерашний — «2 дн.».
function daysSince(iso: string, now: number): number {
  const day = 86_400_000;
  const from = Math.floor(new Date(iso).getTime() / day);
  return Math.max(1, Math.floor(now / day) - from + 1);
}

export function PeriodBar({
  period,
  compare,
  onCompare,
  scope,
  onScope,
  className,
}: {
  period: PeriodState;
  compare: boolean;
  onCompare: (on: boolean) => void;
  scope: Scope;
  onScope: (next: Scope) => void;
  className?: string;
}) {
  const t = useT();
  const previous = period.previous;

  // С какого дня в базе вообще есть счётчики. Читается один раз: это одна строка, и меняется
  // она только при первом в жизни обходе.
  // Число дней считается здесь же, при чтении: часы — не чистая функция, и спрашивать их
  // в теле рендера нельзя. Дата остаётся строкой ISO: её оформление зависит от языка.
  // ⚠️ Три состояния, а не два: «ещё не читали», «снимков нет вовсе» и «есть с такого-то дня».
  // Не прочиталось (ошибка) — остаёмся в первом: сказать «данных ещё нет» вместо «не смогли
  // спросить» значило бы соврать про глубину истории.
  const [history, setHistory] = useState<"unread" | "empty" | { iso: string; days: number }>(
    "unread",
  );
  useEffect(() => {
    let alive = true;
    earliestSnapshotAt().then(
      (iso) => {
        if (!alive) return;
        setHistory(iso === null ? "empty" : { iso, days: daysSince(iso, Date.now()) });
      },
      () => {
        // Оговорки просто не будет.
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  // Текст оговорки один и для строки под полосой, и для тоста.
  const note =
    history === "unread"
      ? null
      : history === "empty"
        ? t("periodBar.allVideosNoteEmpty")
        : t("periodBar.allVideosNote", { days: history.days, date: fmtDayLong(history.iso) });

  function pickScope(next: Scope) {
    onScope(next);
    // Тот же текст, что и строкой ниже: оговорка должна догнать глазами, а не только висеть
    // под полосой. Дата ещё не прочитана — тоста нет, и «один раз за сессию» не потрачен.
    if (next === "all" && note !== null && !shownThisSession()) {
      markShown();
      toast.info(note);
    }
  }

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <PeriodChip period={period} />

        <Button
          type="button"
          size="sm"
          variant={compare ? "secondary" : "outline"}
          aria-pressed={compare}
          onClick={() => onCompare(!compare)}
        >
          <ArrowLeftRightIcon data-icon="inline-start" />
          {t("periodBar.compare")}
        </Button>

        <ScopeSwitch scope={scope} onScope={pickScope} />
      </div>

      {compare && previous && (
        <p className="text-xs text-muted-foreground tabular-nums">
          {t("periodBar.comparedWith", {
            from: fmtDayYear(previous.from),
            to: fmtDayYear(previous.to),
          })}
        </p>
      )}
      {scope === "all" && note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

// Тот же переключатель охвата отдельно: на «Креаторах» полосы периода нет, а охват там
// действует ровно так же — сегмент стоит в шапке страницы.
export function ScopeSwitch({
  scope,
  onScope,
}: {
  scope: Scope;
  onScope: (next: Scope) => void;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-1" role="group" aria-label={t("periodBar.scopeGroup")}>
      {SCOPES.map((key) => (
        <Button
          key={key}
          type="button"
          size="sm"
          variant={scope === key ? "secondary" : "outline"}
          aria-pressed={scope === key}
          onClick={() => onScope(key)}
        >
          {scopeLabel(key)}
        </Button>
      ))}
    </div>
  );
}
