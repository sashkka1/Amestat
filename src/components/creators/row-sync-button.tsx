"use client";

import { useCallback, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useSyncOptions } from "@/components/sync-options";
import {
  SyncDepthAndMax,
  SyncLaunchButton,
  SyncPickGroup,
  SyncSummary,
  SyncVideosGroup,
  allVideosWord,
  pickWords,
  videosWord,
  useSyncRange,
} from "@/components/sync-choice";
import { useT } from "@/lib/i18n";
import { phaseText, unavailableTitle, depthWord, maxVideosWord } from "@/lib/sync-phase";
import type { PeriodRange } from "@/lib/period";
import type { RowSync } from "@/lib/use-sync-queue";
import type { SyncDepth, SyncPick, SyncVideos } from "@/lib/types";
import { cn } from "@/lib/utils";

// Кнопка обновления в строке списка креаторов. Блоков «Кого» и «Площадка» здесь нет: охват
// задан строкой, а площадка у одного креатора одна — выбирать не из чего. Остальное такое
// же, как у кнопки над страницей: блоки «Глубина», «Сколько видео», «Видео» и «Что снимать»,
// сводка и одна кнопка внизу (владелец, 2026-09-09). Общий вид — `components/sync-choice.tsx`.
//
// state — из useSyncQueue: состояние на всю таблицу, а не своё у каждой строки.
export function RowSyncButton({
  state,
  onAsk,
}: {
  state: RowSync | undefined;
  // range — границы глубины «Период»; у остальных глубин его нет вовсе (миграция v18).
  // maxVideos — потолок числа видео на креатора; null — без потолка (миграция v19).
  onAsk: (depth: SyncDepth, pick: SyncPick, maxVideos: number | null, range?: PeriodRange) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // «Что снимать» — то же, что в попапе кнопки над страницей: выбор общий и запоминается.
  const { comments, replies } = useSyncOptions();
  // Кроме третьего блока: «и у не наших видео» не запоминается и гаснет при каждом
  // открытии попапа — как и у кнопки над страницей.
  const [allVideos, setAllVideos] = useState(false);
  // Глубина тоже не запоминается: попап открывается на неделе — она быстрее.
  const [depth, setDepth] = useState<SyncDepth>("week");
  // Охват списка видео (миграция v17). Умолчание — «только наши»: ради экономии времени
  // охват и вводился. Как и глубина, не запоминается и сбрасывается при каждом открытии.
  const [videos, setVideos] = useState<SyncVideos>("ours");
  // Потолок числа видео на креатора (миграция v19). Умолчание — null («Все»), и, как всё
  // остальное здесь, он не запоминается: потолок режет историю, выбирается руками.
  const [maxVideos, setMaxVideos] = useState<number | null>(null);
  // Даты глубины «Период» — своё состояние этого попапа, как и всё остальное в нём.
  const range = useSyncRange();
  const resetRange = range.reset;

  const openChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) return;
      setAllVideos(false);
      setDepth("week");
      setVideos("ours");
      setMaxVideos(null);
      // Умолчание периода — последние 30 дней, при каждом открытии заново.
      resetRange();
    },
    // Держимся за сам reset: объект состояния пересобирается на каждый набранный символ.
    [resetRange],
  );

  if (state) {
    // Пока просьба открыта, кнопка выключена: иначе на одну и ту же работу копится очередь.
    // Подсказка висит на обёртке — у выключенной кнопки отключены и события мыши, а с ними
    // пропал бы и title. «Недоступно» не крутится: ждать нечего, пока сборщик не поднялся.
    // Идёт обход — говорим чей и сколько сделано: «Обход по расписанию · Обновляем 3 из 10
    // · @npodcast123» (миграция v14). Счётчиков ещё нет — остаются слова фазы.
    // Насколько обход близок к концу — тем же счётом, что полоса во всплывашке кнопки
    // «Обновить» (миграция v24). ⚠️ Полосы здесь нет: подсказка строки — это `title`
    // браузера, и разметку он не покажет; доля и прогноз идут словами в ту же строку.
    const title = state.unavailable
      ? unavailableTitle()
      : [state.trigger, state.progress ?? phaseText(state.phase), state.work].filter(Boolean).join(" · ");
    return (
      <span className="inline-flex" title={title}>
        <Button variant="ghost" size="icon-sm" disabled aria-label={title}>
          <RefreshCwIcon className={cn(!state.unavailable && "animate-spin")} />
        </Button>
      </span>
    );
  }

  // Без comments «и у не наших» не значит ничего — гасим и здесь, как у кнопки над страницей.
  const pick: SyncPick = { comments, replies, allVideos: comments && videos !== "ours" && allVideos, videos };

  // Границы уходят только у глубины «Период»: у остальных база требует пустых колонок.
  const asked = depth === "range" ? (range.range ?? undefined) : undefined;

  function ask() {
    setOpen(false);
    onAsk(depth, pick, maxVideos, asked);
  }

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t("sync.rowButton")}
          aria-label={t("sync.rowButton")}
        >
          <RefreshCwIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] gap-3">
        <SyncDepthAndMax depth={depth} onDepth={setDepth} range={range} maxVideos={maxVideos} onMaxVideos={setMaxVideos} />
        <SyncVideosGroup videos={videos} onVideos={setVideos} />
        <SyncPickGroup allVideos={allVideos} onAllVideos={setAllVideos} oursOnly={videos === "ours"} />
        <SyncSummary
          parts={[
            t("sync.summaryThisCreator"),
            depthWord(depth, range.range?.from, range.range?.to),
            maxVideosWord(maxVideos),
            videosWord(pick.videos),
            pickWords(pick),
            pick.allVideos && allVideosWord(),
          ]}
        />
        {/* Выбран «Период», а даты не годятся — просить нечего; почему, сказано под полями. */}
        <SyncLaunchButton
          disabled={depth === "range" && range.range === null}
          sending={false}
          onClick={ask}
        />
      </PopoverContent>
    </Popover>
  );
}
