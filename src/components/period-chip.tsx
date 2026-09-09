"use client";

import { useState } from "react";
import { CalendarIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { periodLabel, type PeriodKey } from "@/lib/period";
import { fmtDayYear } from "@/lib/format";
import { useT } from "@/lib/i18n";
import type { PeriodState } from "@/lib/use-period";
import { cn } from "@/lib/utils";

const KEYS: PeriodKey[] = ["today", "7d", "30d", "all", "custom"];

// Пилюля срока «10 авг 2026 → 8 сен 2026» с готовыми сроками внутри.
export function PeriodChip({ period, className }: { period: PeriodState; className?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const label = period.range
    ? `${fmtDayYear(period.range.from)} → ${fmtDayYear(period.range.to)}`
    : t("period.pickDates");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn("gap-1.5", className)}>
          <CalendarIcon data-icon="inline-start" />
          <span className="tabular-nums">{label}</span>
          <ChevronDownIcon data-icon="inline-end" className="opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        <ul className="flex flex-col">
          {KEYS.map((k) => (
            <li key={k}>
              <button
                type="button"
                onClick={() => {
                  period.setKey(k);
                  if (k !== "custom") setOpen(false);
                }}
                className={cn(
                  "w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                  period.key === k && "bg-muted font-medium",
                )}
              >
                {periodLabel(k)}
              </button>
            </li>
          ))}
        </ul>
        {period.key === "custom" && (
          <div className="mt-2 flex flex-col gap-1.5 border-t pt-2">
            <Input
              type="date"
              value={period.customFrom}
              onChange={(e) => period.setCustom(e.target.value, period.customTo)}
              className="h-8 dark:[color-scheme:dark]"
              aria-label={t("period.fromAria")}
            />
            <Input
              type="date"
              value={period.customTo}
              onChange={(e) => period.setCustom(period.customFrom, e.target.value)}
              className="h-8 dark:[color-scheme:dark]"
              aria-label={t("period.toAria")}
            />
            {!period.range && (
              <p className="text-xs text-destructive">{t("period.badRange")}</p>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
