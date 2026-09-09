// Три состояния видео (владелец, 2026-09-09; миграция v17): «не наше», «смотрим» (жёлтое —
// не наше, но историю счётчиков хотим видеть) и «наше» (зелёное). В базе это две колонки,
// `videos.ours` и `videos.watch`, а на сайте — одно значение: две колонки читаются вместе,
// пишутся вместе и порознь смысла не имеют.
//
// 🔴 `watch` имеет смысл только при `ours = false`. Свести пару к состоянию можно только
// здесь: разъехавшиеся правила дали бы у таблицы один цвет, у карточки — другой.

import { tr } from "@/lib/i18n";

export type VideoState = "none" | "watch" | "ours";

// Порядок сегментов переключателя — от «не наше» к «наше», слева направо.
export const VIDEO_STATES: VideoState[] = ["none", "watch", "ours"];

export function videoState(v: { ours: boolean; watch: boolean }): VideoState {
  return v.ours ? "ours" : v.watch ? "watch" : "none";
}

// Что уходит в базу: две колонки разом, чтобы «наше» и «жёлтое» не оказались включены вместе.
export function stateColumns(state: VideoState): { ours: boolean; watch: boolean } {
  return { ours: state === "ours", watch: state === "watch" };
}

const LABEL_KEY: Record<VideoState, "videoState.none" | "videoState.watch" | "videoState.ours"> = {
  none: "videoState.none",
  watch: "videoState.watch",
  ours: "videoState.ours",
};

export function stateLabel(state: VideoState): string {
  return tr(LABEL_KEY[state]);
}

// Подсказка сегмента: что случится по нажатию. Одни слова на таблицу и карточку видео.
const HINT_KEY: Record<
  VideoState,
  "videoState.hintNone" | "videoState.hintWatch" | "videoState.hintOurs"
> = {
  none: "videoState.hintNone",
  watch: "videoState.hintWatch",
  ours: "videoState.hintOurs",
};

export function stateHint(state: VideoState): string {
  return tr(HINT_KEY[state]);
}

// Цвет строки таблицы. Зелёная полоса — наше, жёлтая — смотрим, приглушено — не наше.
export const STATE_ROW_CLASS: Record<VideoState, string> = {
  none: "text-muted-foreground opacity-60",
  watch: "border-l-2 border-amber-500 bg-amber-500/10",
  ours: "border-l-2 border-emerald-500 bg-emerald-500/10",
};
