"use client";

import { useCallback, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useSyncOptions } from "@/components/sync-options";
import {
  DEPTH_WORD,
  SyncDepthGroup,
  SyncLaunchButton,
  SyncPickGroup,
  SyncSummary,
  pickWords,
} from "@/components/sync-choice";
import { PHASE_TEXT, UNAVAILABLE_TITLE } from "@/lib/sync-phase";
import type { RowSync } from "@/lib/use-sync-queue";
import type { SyncDepth, SyncPick } from "@/lib/types";
import { cn } from "@/lib/utils";

// Кнопка обновления в строке списка креаторов. Блоков «Кого» и «Площадка» здесь нет: охват
// задан строкой, а площадка у одного креатора одна — выбирать не из чего. Остальное такое
// же, как у кнопки над страницей: блоки «Глубина» и «Что снимать», сводка и одна кнопка
// внизу (владелец, 2026-09-09). Общий вид — `components/sync-choice.tsx`.
//
// state — из useSyncQueue: состояние на всю таблицу, а не своё у каждой строки.
export function RowSyncButton({
  state,
  onAsk,
}: {
  state: RowSync | undefined;
  onAsk: (depth: SyncDepth, pick: SyncPick) => void;
}) {
  const [open, setOpen] = useState(false);
  // «Что снимать» — то же, что в попапе кнопки над страницей: выбор общий и запоминается.
  const { comments, replies } = useSyncOptions();
  // Кроме третьего блока: «и у не наших видео» не запоминается и гаснет при каждом
  // открытии попапа — как и у кнопки над страницей.
  const [allVideos, setAllVideos] = useState(false);
  // Глубина тоже не запоминается: попап открывается на неделе — она быстрее.
  const [depth, setDepth] = useState<SyncDepth>("week");

  const openChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) return;
    setAllVideos(false);
    setDepth("week");
  }, []);

  if (state) {
    // Пока просьба открыта, кнопка выключена: иначе на одну и ту же работу копится очередь.
    // Подсказка висит на обёртке — у выключенной кнопки отключены и события мыши, а с ними
    // пропал бы и title. «Недоступно» не крутится: ждать нечего, пока сборщик не поднялся.
    // Идёт обход — говорим чей и сколько сделано: «Обход по расписанию · Обновляем 3 из 10
    // · @npodcast123» (миграция v14). Счётчиков ещё нет — остаются слова фазы.
    const title = state.unavailable
      ? UNAVAILABLE_TITLE
      : [state.trigger, state.progress ?? PHASE_TEXT[state.phase]].filter(Boolean).join(" · ");
    return (
      <span className="inline-flex" title={title}>
        <Button variant="ghost" size="icon-sm" disabled aria-label={title}>
          <RefreshCwIcon className={cn(!state.unavailable && "animate-spin")} />
        </Button>
      </span>
    );
  }

  // Без comments «все видео» не значит ничего — гасим и здесь, как у кнопки над страницей.
  const pick: SyncPick = { comments, replies, allVideos: comments && allVideos };

  function ask() {
    setOpen(false);
    onAsk(depth, pick);
  }

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" title="Обновить креатора" aria-label="Обновить креатора">
          <RefreshCwIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-w-[calc(100vw-2rem)]">
        <SyncDepthGroup depth={depth} onDepth={setDepth} />
        <SyncPickGroup allVideos={allVideos} onAllVideos={setAllVideos} />
        <SyncSummary
          parts={[
            "Этот креатор",
            DEPTH_WORD[depth],
            pickWords(pick),
            pick.allVideos && "все видео",
          ]}
        />
        <SyncLaunchButton disabled={false} sending={false} onClick={ask} />
      </PopoverContent>
    </Popover>
  );
}
