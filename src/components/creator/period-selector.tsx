"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PERIOD_LABELS, type PeriodKey } from "@/lib/period";

const KEYS: PeriodKey[] = ["today", "7d", "30d", "all", "custom"];

export function PeriodSelector({
  value,
  onChange,
  customFrom,
  customTo,
  onCustomChange,
}: {
  value: PeriodKey;
  onChange: (k: PeriodKey) => void;
  customFrom: string;
  customTo: string;
  onCustomChange: (from: string, to: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-1 rounded-lg border p-0.5">
        {KEYS.map((k) => (
          <Button
            key={k}
            size="sm"
            variant={value === k ? "secondary" : "ghost"}
            onClick={() => onChange(k)}
          >
            {PERIOD_LABELS[k]}
          </Button>
        ))}
      </div>
      {value === "custom" && (
        <div className="flex items-center gap-1.5 text-sm">
          <Input
            type="date"
            value={customFrom}
            onChange={(e) => onCustomChange(e.target.value, customTo)}
            className="h-8 w-auto"
            aria-label="С"
          />
          <span className="text-muted-foreground">—</span>
          <Input
            type="date"
            value={customTo}
            onChange={(e) => onCustomChange(customFrom, e.target.value)}
            className="h-8 w-auto"
            aria-label="По"
          />
        </div>
      )}
    </div>
  );
}
