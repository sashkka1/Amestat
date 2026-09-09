"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowLeftRightIcon } from "lucide-react";
import { PeriodChip } from "@/components/period-chip";
import { Button } from "@/components/ui/button";
import { SCOPES, scopeLabel, type Scope } from "@/lib/dashboard-prefs";
import { fmtDateTime, fmtDayYear } from "@/lib/format";
import { latestRun } from "@/lib/api/sync";
import { depthWord } from "@/lib/sync-phase";
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
// Осталась другая оговорка, и она про «Все видео»: свежесть чисел упирается в последний
// обход сборщика — когда он был и на какую глубину ходил. Не сказать об этом — значит
// показать пустой хвост графика как провал.

export function PeriodBar({
  period,
  compare,
  onCompare,
  scope,
  onScope,
  runScope = null,
  className,
}: {
  period: PeriodState;
  compare: boolean;
  onCompare: (on: boolean) => void;
  scope: Scope;
  onScope: (next: Scope) => void;
  // Чей обход показывать в оговорке: null — любой последний, иначе id креатора.
  runScope?: string | null;
  className?: string;
}) {
  const t = useT();
  const previous = period.previous;

  // Последний завершённый обход: когда обновлялись и за какой срок снимались данные
  // (владелец, 2026-09-09: «мне нужно понять, за какой период актуальные данные и когда
  // последний раз обновлял»). Читается один раз при монтировании.
  const [last, setLast] = useState<"unread" | "empty" | { when: string; depth: string }>("unread");
  useEffect(() => {
    let alive = true;
    latestRun(runScope ?? undefined).then((res) => {
      if (!alive || !res.ok) return;
      const run = res.data;
      if (!run || !run.finished_at) {
        setLast("empty");
        return;
      }
      setLast({ when: fmtDateTime(run.finished_at), depth: depthWord(run.depth, run.depth_from, run.depth_to) });
    });
    return () => {
      alive = false;
    };
  }, [runScope]);

  // Текст оговорки для тоста при переключении на «Все видео».
  const note =
    last === "unread"
      ? null
      : last === "empty"
        ? t("periodBar.allVideosNoteEmpty")
        : t("periodBar.allVideosNote", { when: last.when, depth: last.depth });

  // Оговорки живут только всплывашками (владелец, 2026-09-09: «пусть уведомляшка показывается,
  // но больше ничего не нужно — текстовый дубляж не нужен»): каждое переключение на «Все видео»
  // и каждое включение сравнения показывают тост, который сам закрывается.
  function pickScope(next: Scope) {
    onScope(next);
    if (next === "all" && note !== null) toast.info(note);
  }

  function pickCompare(on: boolean) {
    onCompare(on);
    if (on && previous) {
      toast.info(
        t("periodBar.comparedWith", { from: fmtDayYear(previous.from), to: fmtDayYear(previous.to) }),
      );
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
          onClick={() => pickCompare(!compare)}
        >
          <ArrowLeftRightIcon data-icon="inline-start" />
          {t("periodBar.compare")}
        </Button>

        <ScopeSwitch scope={scope} onScope={pickScope} />
      </div>

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
