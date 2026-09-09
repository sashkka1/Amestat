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
import { tr, useT } from "@/lib/i18n";
import { rangeRequired } from "@/lib/sync-phase";
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

// Группа блоков — ряд одинаковых по высоте блоков. Заголовок группы не рисуется (владелец,
// 2026-09-09: «без подписей, блоки на одном расстоянии»), но остаётся подписью для читалки.
export function SyncGroup({
  title,
  cols = 2,
  children,
}: {
  title: string;
  cols?: 2 | 3 | 4;
  children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={title}
      className={cn("grid gap-1", cols === 4 ? "grid-cols-4" : cols === 3 ? "grid-cols-3" : "grid-cols-2")}
    >
      {children}
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
      {/* Пояснение блока не печатается (владелец, 2026-09-09: «без подписей — только названия»),
          оно живёт во всплывающей подсказке, если нет другой. */}
      <button
        type="button"
        aria-pressed={selected}
        disabled={disabled}
        onClick={onClick}
        title={title === undefined ? hint : undefined}
        className={cn(
          "flex min-h-9 w-full items-center justify-center gap-1 rounded-md border px-2.5 py-2 text-sm leading-tight font-medium transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
          selected
            ? "border-transparent bg-foreground text-background"
            : "border-border bg-background hover:bg-muted dark:bg-input/30 dark:hover:bg-input/50",
        )}
      >
        {icon}
        {label}
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
  const t = useT();
  const max = todayValue();
  return (
    <SyncGroup title={t("syncChoice.depthGroup")}>
      <SyncChoiceBlock
        label={t("syncChoice.depthWeek")}
        hint={t("syncChoice.depthWeekHint")}
        selected={depth === "week"}
        onClick={() => onDepth("week")}
      />
      <SyncChoiceBlock
        label={t("syncChoice.depthMonth")}
        hint={t("syncChoice.depthMonthHint")}
        selected={depth === "month"}
        onClick={() => onDepth("month")}
      />
      <SyncChoiceBlock
        label={t("syncChoice.depthAll")}
        hint={t("syncChoice.depthAllHint")}
        selected={depth === "all"}
        onClick={() => onDepth("all")}
      />
      <SyncChoiceBlock
        label={t("syncChoice.depthRange")}
        hint={t("syncChoice.depthRangeHint")}
        selected={depth === "range"}
        onClick={() => onDepth("range")}
      />
      {depth === "range" && (
        <div className="col-span-2 flex flex-col gap-1">
          <div className="grid grid-cols-2 gap-1.5">
            {/* max — сегодня: «по» не позже сегодняшнего дня, и календарь браузера дальше
                не пускает. Набранную руками будущую дату подрезает resolveSyncRange. */}
            <SyncDateField
              label={t("syncChoice.from")}
              aria={t("period.fromAria")}
              value={range.from}
              max={max}
              onChange={range.setFrom}
            />
            <SyncDateField
              label={t("syncChoice.to")}
              aria={t("period.toAria")}
              value={range.to}
              max={max}
              onChange={range.setTo}
            />
          </div>
          {/* Кнопка внизу в это время выключена — без строки было бы непонятно, почему. */}
          {range.range === null && (
            <p className="text-xs leading-snug text-destructive">{rangeRequired()}</p>
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
  const t = useT();
  return (
    <SyncGroup title={t("syncChoice.maxVideosGroup")}>
      {MAX_VIDEOS_CHOICES.map((n) => (
        <SyncChoiceBlock
          key={n ?? "all"}
          label={n === null ? t("syncChoice.maxAll") : String(n)}
          hint={n === null ? t("syncChoice.maxAllHint") : t("syncChoice.maxHint")}
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
export function videosWord(videos: SyncVideos): string {
  return tr(videos === "all" ? "syncChoice.wordVideosAll" : "syncChoice.wordVideosOurs");
}

export function SyncVideosGroup({
  videos,
  onVideos,
}: {
  videos: SyncVideos;
  onVideos: (next: SyncVideos) => void;
}) {
  const t = useT();
  return (
    <SyncGroup title={t("syncChoice.videosGroup")}>
      <SyncChoiceBlock
        label={t("syncChoice.videosAll")}
        hint={t("syncChoice.videosAllHint")}
        selected={videos === "all"}
        onClick={() => onVideos("all")}
      />
      <SyncChoiceBlock
        label={t("syncChoice.videosOurs")}
        hint={t("syncChoice.videosOursHint")}
        selected={videos === "ours"}
        onClick={() => onVideos("ours")}
      />
    </SyncGroup>
  );
}

// Что снимать. Оба блока запоминаются (`useSyncOptions`).
//
// 🔴 Третьего блока, «И у не наших видео», больше нет (владелец, 2026-09-09): у кого брать
// тексты, решает охват списка (`SyncVideosGroup`), а не отдельная галочка. Флаг просьбы
// `all_videos` теперь выводится — `comments && videos === 'all'`: охват «Всё» значит тексты
// у всех видео глубины, «Только наши» — у наших и жёлтых. Два способа сказать одно и то же
// разъезжались: можно было выбрать «Только наши» и включить «и у не наших».
export function SyncPickGroup() {
  const t = useT();
  const { comments, replies, setComments, setReplies } = useSyncOptions();
  const noCommentsTitle = t("syncChoice.noCommentsTitle");

  return (
    <SyncGroup title={t("syncChoice.pickGroup")}>
      <SyncChoiceBlock
        label={t("syncChoice.comments")}
        hint={t("syncChoice.commentsHint")}
        selected={comments}
        onClick={() => setComments(!comments)}
      />
      <SyncChoiceBlock
        label={t("syncChoice.replies")}
        hint={t("syncChoice.repliesHint")}
        selected={comments && replies}
        disabled={!comments}
        title={comments ? undefined : noCommentsTitle}
        onClick={() => setReplies(!replies)}
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
  if (!pick.comments) return tr("syncChoice.wordNoComments");
  return tr(pick.replies ? "syncChoice.wordCommentsReplies" : "syncChoice.wordComments");
}

// 🔴 Флаг просьбы `all_videos` не выбирается, а выводится (владелец, 2026-09-09): у кого
// брать тексты комментариев, решает охват списка. «Всё» — у всех видео глубины, «Только
// наши» — у наших и жёлтых. Без комментариев флаг не значит ничего.
// Считается здесь по одному разу: обе кнопки («Обновить» над страницей и кнопка строки
// списка) обязаны собирать просьбу одинаково.
export function allVideosFlag(pick: { comments: boolean; videos: SyncVideos }): boolean {
  return pick.comments && pick.videos === "all";
}

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
  const t = useT();
  return (
    <Button type="button" className="w-full" disabled={disabled || sending} onClick={onClick}>
      <RefreshCwIcon data-icon="inline-start" className={cn(sending && "animate-spin")} />
      {sending ? t("syncChoice.sending") : t("syncChoice.launch")}
    </Button>
  );
}

// Глубина и потолок — два квадрата 2×2 рядом (владелец, 2026-09-09: «неделя, месяц, снизу
// всё, период; правее такой же блок с количеством»). Внутри плотно, между квадратами просторно.
export function SyncDepthAndMax({
  depth,
  onDepth,
  range,
  maxVideos,
  onMaxVideos,
}: {
  depth: SyncDepth;
  onDepth: (next: SyncDepth) => void;
  range: SyncRangeState;
  maxVideos: number | null;
  onMaxVideos: (next: number | null) => void;
}) {
  return (
    <div className="grid grid-cols-2 items-start gap-3">
      <SyncDepthGroup depth={depth} onDepth={onDepth} range={range} />
      <SyncMaxVideosGroup maxVideos={maxVideos} onMaxVideos={onMaxVideos} />
    </div>
  );
}
