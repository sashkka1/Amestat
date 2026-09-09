"use client";

import { CheckIcon, EyeIcon, MinusIcon } from "lucide-react";
import {
  VIDEO_STATES,
  stateHint,
  stateLabel,
  type VideoState,
} from "@/lib/video-state";
import { cn } from "@/lib/utils";

// Переключатель состояния видео: три сегмента вместо прежней галочки «наше» (владелец,
// 2026-09-09). Один и тот же в таблице видео (`stats/videos-table.tsx`) и в карточке
// выбранного видео (`creator/video-panel.tsx`) — иначе два места разъедутся в словах и цвете.
//
// Сегменты — обычные кнопки с aria-pressed, а не радиогруппа: нажатие сразу пишет в базу,
// а строка обновляется оптимистично. Подписи скрыты в таблице (колонка узкая) и видны в
// карточке; и там и там у сегмента есть title и aria-label — иконка без слов ничего не значит.

const ICONS: Record<VideoState, typeof CheckIcon> = {
  none: MinusIcon,
  watch: EyeIcon,
  ours: CheckIcon,
};

// Цвет выбранного сегмента: зелёный — наше, жёлтый — смотрим, серый — не наше. Те же цвета,
// что у полосы строки в таблице (STATE_ROW_CLASS).
const SELECTED: Record<VideoState, string> = {
  none: "bg-muted text-foreground",
  watch: "bg-amber-500 text-white",
  ours: "bg-emerald-500 text-white",
};

export function VideoStateToggle({
  state,
  onChange,
  withLabels = false,
  disabled = false,
  className,
}: {
  state: VideoState;
  onChange: (next: VideoState) => void;
  // Показывать слова рядом с иконками — в карточке видео места хватает.
  withLabels?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border bg-background p-0.5 dark:bg-input/30",
        className,
      )}
    >
      {VIDEO_STATES.map((s) => {
        const Icon = ICONS[s];
        const on = s === state;
        const label = stateLabel(s);
        return (
          <button
            key={s}
            type="button"
            aria-pressed={on}
            aria-label={label}
            title={stateHint(s)}
            disabled={disabled}
            // Нажатие на уже выбранный сегмент ничего не меняет: снимать состояние некуда,
            // «не наше» — это тоже состояние, а не отсутствие выбора.
            onClick={() => {
              if (!on) onChange(s);
            }}
            className={cn(
              "inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs leading-none transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
              on ? SELECTED[s] : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {withLabels && label}
          </button>
        );
      })}
    </div>
  );
}
