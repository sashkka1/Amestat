"use client";

import { useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PHASE_TEXT, UNAVAILABLE_TITLE } from "@/lib/sync-phase";
import type { RowSync } from "@/lib/use-sync-queue";
import type { SyncDepth } from "@/lib/types";
import { cn } from "@/lib/utils";

// Кнопка обновления в строке списка креаторов. Матрица кнопки над страницей здесь не нужна:
// охват уже задан строкой — остаётся выбрать глубину.
//
// state — из useSyncQueue: состояние на всю таблицу, а не своё у каждой строки.
export function RowSyncButton({
  state,
  onAsk,
}: {
  state: RowSync | undefined;
  onAsk: (depth: SyncDepth) => void;
}) {
  const [open, setOpen] = useState(false);

  if (state) {
    // Пока просьба открыта, кнопка выключена: иначе на одну и ту же работу копится очередь.
    // Подсказка висит на обёртке — у выключенной кнопки отключены и события мыши, а с ними
    // пропал бы и title. «Недоступно» не крутится: ждать нечего, пока сборщик не поднялся.
    const title = state.unavailable ? UNAVAILABLE_TITLE : PHASE_TEXT[state.phase];
    return (
      <span className="inline-flex" title={title}>
        <Button variant="ghost" size="icon-sm" disabled aria-label={title}>
          <RefreshCwIcon className={cn(!state.unavailable && "animate-spin")} />
        </Button>
      </span>
    );
  }

  function ask(depth: SyncDepth) {
    setOpen(false);
    onAsk(depth);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" title="Обновить креатора" aria-label="Обновить креатора">
          <RefreshCwIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60">
        <div className="grid grid-cols-2 gap-1.5">
          <Button variant="outline" size="sm" onClick={() => ask("all")}>
            Всё
          </Button>
          <Button variant="outline" size="sm" onClick={() => ask("week")}>
            Последняя неделя
          </Button>
        </div>
        <p className="text-xs leading-snug text-muted-foreground">
          Неделя — быстрее: только видео за 7 дней.
        </p>
      </PopoverContent>
    </Popover>
  );
}
