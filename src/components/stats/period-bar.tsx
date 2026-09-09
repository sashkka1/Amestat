"use client";

import { ArrowLeftRightIcon } from "lucide-react";
import { PeriodChip } from "@/components/period-chip";
import { Button } from "@/components/ui/button";
import { SCOPES, scopeLabel, type Scope } from "@/lib/dashboard-prefs";
import { fmtDayYear } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { PeriodState } from "@/lib/use-period";
import { cn } from "@/lib/utils";

// Полоса под заголовком дашборда: чем ограничена вся страница по времени и по видео.
// Слева — та же пилюля срока, что стояла в шапке (она и так подписана датами границ),
// правее — сравнение с прошлым сроком и охват «Все видео / Только наши».
//
// ⚠️ Подпись под полосой — не украшение: пока сравнение включено, надо видеть, с какими
// именно датами сравниваются плитки, а пока охват сужен — что часть блоков ему не подчиняется
// (их суммы считает база, и про «наше / жёлтое» она не знает).
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
      </div>

      {compare && previous && (
        <p className="text-xs text-muted-foreground tabular-nums">
          {t("periodBar.comparedWith", {
            from: fmtDayYear(previous.from),
            to: fmtDayYear(previous.to),
          })}
        </p>
      )}
      {scope === "ours" && (
        <p className="text-xs text-muted-foreground">{t("periodBar.scopeServerNote")}</p>
      )}
    </div>
  );
}
