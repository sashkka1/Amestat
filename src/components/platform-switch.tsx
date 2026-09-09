"use client";

import { PlatformIcon } from "@/components/platform";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import {
  platformFilterLabel,
  type PlatformFilter,
  type PlatformFilterState,
} from "@/lib/platform-filter";
import { cn } from "@/lib/utils";

const KEYS: PlatformFilter[] = ["all", "tiktok", "instagram"];

// Три кнопки в ряд рядом с пилюлей срока: чем страница ограничена по площадке.
// Выбранная — `secondary`, остальные — `outline`, как чипы площадки в «Новом креаторе».
export function PlatformSwitch({
  state,
  className,
}: {
  state: PlatformFilterState;
  className?: string;
}) {
  const t = useT();
  return (
    <div
      className={cn("flex items-center gap-1", className)}
      role="group"
      aria-label={t("platform.group")}
    >
      {KEYS.map((key) => {
        const on = state.filter === key;
        return (
          <Button
            key={key}
            type="button"
            size="sm"
            variant={on ? "secondary" : "outline"}
            aria-pressed={on}
            onClick={() => state.setFilter(key)}
          >
            {key !== "all" && <PlatformIcon platform={key} />}
            {platformFilterLabel(key)}
          </Button>
        );
      })}
    </div>
  );
}
