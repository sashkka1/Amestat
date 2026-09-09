"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSyncOptions } from "@/components/sync-options";
import {
  endOfLocalDay,
  fromDateInputValue,
  startOfLocalDay,
  toDateInputValue,
  type PeriodRange,
} from "@/lib/period";
import { RANGE_REQUIRED } from "@/lib/sync-phase";
import type { SyncDepth, SyncPick, SyncVideos } from "@/lib/types";
import { cn } from "@/lib/utils";

// Общий вид попапа «Обновить» (владелец, 2026-09-09): вместо матрицы и галочек с абзацами
// объяснений — прямоугольные блоки-кнопки, у каждого внутри название и одна короткая
// подсказка. Выбранный блок чёрный (в тёмной теме — светлый: `bg-foreground text-background`),
// невыбранный — с рамкой. Нажатие на блок ничего не отправляет: оно меняет выбор, а просьба
// уходит одной кнопкой внизу.
//
// Кусок общий у кнопки над страницей (`sync-button.tsx`) и кнопки в строке списка
// (`creators/row-sync-button.tsx`) — иначе два попапа разъедутся в виде. Здесь лежит только
// внешний вид и склейка слов; какие id, флаги и глубина уходят в базу, решают сами кнопки.

// Группа блоков: короткий заголовок серым и ряд одинаковых по высоте блоков.
export function SyncGroup({
  title,
  cols = 2,
  children,
}: {
  title: string;
  cols?: 2 | 3;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs leading-tight text-muted-foreground">{title}</span>
      <div className={cn("grid gap-1.5", cols === 3 ? "grid-cols-3" : "grid-cols-2")}>{children}</div>
    </div>
  );
}

// Блок-кнопка. Обёртка нужна ради подсказки: у выключенной кнопки браузер не шлёт события
// мыши, и title на ней самой не показался бы (так же сделана кнопка строки в покое).
export function SyncChoiceBlock({
  label,
  hint,
  icon,
  selected,
  disabled = false,
  title,
  onClick,
  className,
}: {
  label: string;
  hint: string;
  icon?: ReactNode;
  selected: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <span className={cn("flex", className)} title={title}>
      <button
        type="button"
        aria-pressed={selected}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "flex w-full flex-col items-start gap-0.5 rounded-lg border px-2 py-1.5 text-left transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
          selected
            ? "border-transparent bg-foreground text-background"
            : "border-border bg-background hover:bg-muted dark:bg-input/30 dark:hover:bg-input/50",
        )}
      >
        <span className="flex items-center gap-1 text-sm leading-tight font-medium">
          {icon}
          {label}
        </span>
        <span
          className={cn(
            "text-xs leading-tight",
            selected ? "text-background/70" : "text-muted-foreground",
          )}
        >
          {hint}
        </span>
      </button>
    </span>
  );
}

// Период обхода: поля «с» и «по» под группой глубины (владелец, 2026-09-09; миграция v18).
// Состояние живёт в попапе — своё у кнопки над страницей и у кнопки строки, и сбрасывается
// при каждом открытии: тяжёлый обход по датам выбирается руками каждый раз.
export type SyncRangeState = {
  // Строки поля <input type="date"> (YYYY-MM-DD), как в «своём сроке» статистики.
  from: string;
  to: string;
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
  reset: () => void;
  // Готовые границы просьбы; null — поля пусты или «с» не раньше «по».
  range: PeriodRange | null;
};

const DAY_MS = 86_400_000;

// Умолчание при первом раскрытии — последние 30 дней.
function defaultFrom(): string {
  return toDateInputValue(new Date(Date.now() - 30 * DAY_MS));
}

function todayValue(): string {
  return toDateInputValue(new Date());
}

// Границы просьбы из двух полей: «с» — начало дня, «по» — конец дня по местному времени.
// ⚠️ «по» не позже сегодня: набранная руками будущая дата подрезается до сегодняшней, и
// сводка под кнопкой показывает уже подрезанную — уходит ровно то, что там написано.
// Один и тот же день в обоих полях допустим: 00:00:00.000 < 23:59:59.999.
export function resolveSyncRange(from: string, to: string): PeriodRange | null {
  const f = fromDateInputValue(from);
  const t = fromDateInputValue(to);
  if (!f || !t) return null;
  const now = new Date();
  const start = startOfLocalDay(f);
  const end = endOfLocalDay(t > now ? now : t);
  return start < end ? { from: start, to: end } : null;
}

export function useSyncRange(): SyncRangeState {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(todayValue);
  const reset = useCallback(() => {
    setFrom(defaultFrom());
    setTo(todayValue());
  }, []);
  const range = useMemo(() => resolveSyncRange(from, to), [from, to]);
  return { from, to, setFrom, setTo, reset, range };
}

// Одно поле даты: подпись слева, поле справа. `[color-scheme:dark]` — ради тёмной темы:
// иконку календаря и выпадающий календарь рисует сам браузер, и без этого они остаются
// белыми пятнами на тёмном попапе.
function SyncDateField({
  label,
  aria,
  value,
  max,
  onChange,
}: {
  label: string;
  aria: string;
  value: string;
  max: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {label}
      <Input
        type="date"
        value={value}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 dark:[color-scheme:dark]"
        aria-label={aria}
      />
    </label>
  );
}

// Глубина обхода — одинаковая у обеих кнопок. Четыре блока (владелец, 2026-09-09):
// «Всё», «Неделя», «Месяц», «Период»; у последнего под группой раскрываются две даты.
export function SyncDepthGroup({
  depth,
  onDepth,
  range,
}: {
  depth: SyncDepth;
  onDepth: (next: SyncDepth) => void;
  range: SyncRangeState;
}) {
  const max = todayValue();
  return (
    <SyncGroup title="Глубина">
      <SyncChoiceBlock
        label="Всё"
        hint="весь список видео, долго"
        selected={depth === "all"}
        onClick={() => onDepth("all")}
      />
      <SyncChoiceBlock
        label="Неделя"
        hint="видео за 7 дней"
        selected={depth === "week"}
        onClick={() => onDepth("week")}
      />
      <SyncChoiceBlock
        label="Месяц"
        hint="видео за 30 дней"
        selected={depth === "month"}
        onClick={() => onDepth("month")}
      />
      <SyncChoiceBlock
        label="Период"
        hint="выбрать даты"
        selected={depth === "range"}
        onClick={() => onDepth("range")}
      />
      {depth === "range" && (
        <div className="col-span-2 flex flex-col gap-1.5">
          <div className="grid grid-cols-2 gap-1.5">
            {/* max — сегодня: «по» не позже сегодняшнего дня, и календарь браузера дальше
                не пускает. Набранную руками будущую дату подрезает resolveSyncRange. */}
            <SyncDateField
              label="с"
              aria="С какого дня"
              value={range.from}
              max={max}
              onChange={range.setFrom}
            />
            <SyncDateField
              label="по"
              aria="По какой день"
              value={range.to}
              max={max}
              onChange={range.setTo}
            />
          </div>
          {/* Кнопка внизу в это время выключена — без строки было бы непонятно, почему. */}
          {range.range === null && (
            <p className="text-xs leading-snug text-destructive">{RANGE_REQUIRED}</p>
          )}
        </div>
      )}
    </SyncGroup>
  );
}

// Сколько видео на креатора (владелец, 2026-09-09; миграция v19): «у креатора с 500 видео и
// без свежих публикаций „неделя“ пуста, а „всё“ листает всю историю». Потолок ложится поверх
// глубины по времени: берутся столько самых новых видео, сколько выбрано. «Все» — без
// потолка, как было всегда, поэтому и умолчание попапа.
//
// 🔴 Слово потолка живёт в `lib/sync-phase.ts` (maxVideosWord, maxVideosTail) по одному
// разу — его зовут и сводки обоих попапов, и строки состояния, и тосты очереди.
export const MAX_VIDEOS_CHOICES: (number | null)[] = [20, 50, 100, null];

export function SyncMaxVideosGroup({
  maxVideos,
  onMaxVideos,
}: {
  maxVideos: number | null;
  onMaxVideos: (next: number | null) => void;
}) {
  return (
    <SyncGroup title="Сколько видео">
      {MAX_VIDEOS_CHOICES.map((n) => (
        <SyncChoiceBlock
          key={n ?? "all"}
          label={n === null ? "Все" : String(n)}
          hint={n === null ? "без потолка" : "самых новых в пределах глубины"}
          selected={maxVideos === n}
          onClick={() => onMaxVideos(n)}
        />
      ))}
    </SyncGroup>
  );
}

// Охват списка видео (владелец, 2026-09-09; миграция v17): «всё» — весь список, как в
// ежедневном обходе; «только наши» — наши и жёлтые, остальные не смотрим и экономим время.
// Ради этого охват и вводился, поэтому попап открывается на «только наши»; ежедневные обходы
// всегда идут с 'all' и хвоста в строках состояния не получают.
//
// 🔴 Слова группы и хвостов живут здесь и в `lib/sync-phase.ts` по одному разу: попап кнопки
// над страницей, попап строки списка и очередь строк обязаны называть охват одинаково.
export const VIDEOS_WORD: Record<SyncVideos, string> = { all: "все видео", ours: "только наши" };

export function SyncVideosGroup({
  videos,
  onVideos,
}: {
  videos: SyncVideos;
  onVideos: (next: SyncVideos) => void;
}) {
  return (
    <SyncGroup title="Видео">
      <SyncChoiceBlock
        label="Всё"
        hint="весь список, как в ежедневном обходе"
        selected={videos === "all"}
        onClick={() => onVideos("all")}
      />
      <SyncChoiceBlock
        label="Только наши"
        hint="наши и жёлтые видео, остальное не смотрим — быстрее"
        selected={videos === "ours"}
        onClick={() => onVideos("ours")}
      />
    </SyncGroup>
  );
}

// Что снимать. Первые два блока запоминаются (`useSyncOptions`), третий приходит параметрами
// и гаснет при каждом открытии попапа — правило не изменилось, изменился только вид.
const NO_COMMENTS_TITLE = "Без комментариев снимать нечего";
const OURS_ONLY_TITLE = "При охвате «Только наши» не наши видео не открываются";

export function SyncPickGroup({
  allVideos,
  onAllVideos,
  oursOnly = false,
}: {
  allVideos: boolean;
  onAllVideos: (on: boolean) => void;
  // Охват «Только наши»: лишние видео не смотрим вовсе, значит и тексты у не наших взять не
  // из чего — блок гаснет, а не молчаливо противоречит сводке.
  oursOnly?: boolean;
}) {
  const { comments, replies, setComments, setReplies } = useSyncOptions();

  // Сняли «Комментарии» — гаснут оба нижних блока: без текстов снимать нечего ни в ветках,
  // ни у не наших видео. `replies` гасит сам стор, а третий — вот эта строка.
  function toggleComments() {
    const on = !comments;
    setComments(on);
    if (!on) onAllVideos(false);
  }

  return (
    <SyncGroup title="Что снимать">
      <SyncChoiceBlock
        label="Комментарии"
        hint="тексты комментариев у наших видео"
        selected={comments}
        onClick={toggleComments}
      />
      <SyncChoiceBlock
        label="Ветки ответов"
        hint="раскрывать ответы под комментариями"
        selected={comments && replies}
        disabled={!comments}
        title={comments ? undefined : NO_COMMENTS_TITLE}
        onClick={() => setReplies(!replies)}
      />
      <SyncChoiceBlock
        className="col-span-2"
        label="И у не наших видео"
        hint="тексты и у не помеченных, долго"
        selected={comments && !oursOnly && allVideos}
        disabled={!comments || oursOnly}
        title={!comments ? NO_COMMENTS_TITLE : oursOnly ? OURS_ONLY_TITLE : undefined}
        onClick={() => onAllVideos(!allVideos)}
      />
    </SyncGroup>
  );
}

// Слова сводки. Собираются из того же выбора, что уходит в просьбу, — чтобы под кнопкой
// стояло ровно то, что случится по нажатию.
// ⚠️ Слова глубины и потолка видео сюда не переезжают: они живут в `lib/sync-phase.ts`
// (DEPTH_WORD, depthWord, depthTail, maxVideosWord, maxVideosTail) — их зовут и попапы,
// и строки состояния, и тосты очереди.

export function pickWords(pick: SyncPick): string {
  if (!pick.comments) return "без комментариев";
  return pick.replies ? "комментарии и ветки" : "комментарии";
}

// Слово блока «И у не наших видео» в сводке. Раньше было «все видео», но так теперь зовётся
// охват списка (VIDEOS_WORD.all) — одно и то же слово о двух разных вещах в одной строке
// сводки читалось бы как противоречие: «только наши · все видео».
export const ALL_VIDEOS_WORD = "тексты у не наших";

// Сводка выбора одной строкой: «Все креаторы · TikTok · неделя · комментарии и ветки».
// Пустые куски выпадают — площадки «Все» в строке нет, как нет её и в хвосте состояния.
export function SyncSummary({ parts }: { parts: (string | null | false)[] }) {
  const text = parts.filter((p): p is string => typeof p === "string" && p !== "").join(" · ");
  return <p className="text-xs leading-snug text-muted-foreground">{text}</p>;
}

// Подтверждение: одна широкая кнопка, которая и отправляет просьбу.
export function SyncLaunchButton({
  disabled,
  sending,
  onClick,
}: {
  disabled: boolean;
  sending: boolean;
  onClick: () => void;
}) {
  return (
    <Button type="button" className="w-full" disabled={disabled || sending} onClick={onClick}>
      <RefreshCwIcon data-icon="inline-start" className={cn(sending && "animate-spin")} />
      {sending ? "Отправляем…" : "Запустить обновление"}
    </Button>
  );
}
