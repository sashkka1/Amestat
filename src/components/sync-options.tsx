"use client";

import { useCallback, useSyncExternalStore } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

// Три пункта попапа «Обновить» (владелец, 2026-09-08): что именно снимать в этом обходе —
// тексты комментариев, ветки ответов под ними и надо ли брать тексты у не наших видео.
// Уходят в просьбу как sync_requests.comments и .replies (миграция v12) и .all_videos (v13).
//
// Кусок общий для кнопки над страницей (`sync-button.tsx`) и кнопки в строке списка
// (`creators/row-sync-button.tsx`): выбор один на оба места и живёт в localStorage — как
// переключатель площадки в `lib/platform-filter.ts`.
//
// 🔴 Третья галочка — исключение: она НЕ запоминается и при каждом открытии попапа стоит
// выключенной. Тексты у всех видео подряд — самый долгий обход, и такой запрос должен быть
// осознанным каждый раз, а не унаследованным от прошлого раза. Поэтому её состояние живёт
// в попапе (useState у кнопки), а сюда приходит параметрами.

export const SYNC_COMMENTS_KEY = "amestat.sync.comments";
export const SYNC_REPLIES_KEY = "amestat.sync.replies";

export type SyncOptions = { comments: boolean; replies: boolean };

// По умолчанию снимаем всё: обход по расписанию делает то же самое.
const DEFAULT: SyncOptions = { comments: true, replies: true };

// Хранилища может не быть (приватный режим, запрет на сайт), и оно кидает прямо на
// обращении — поэтому и чтение, и запись в try/catch. Не прочиталось — значит «снимать».
function readSaved(): SyncOptions {
  try {
    const comments = window.localStorage.getItem(SYNC_COMMENTS_KEY) !== "0";
    const replies = window.localStorage.getItem(SYNC_REPLIES_KEY) !== "0";
    // Ветки без комментариев не снимаются — чинить перекос лучше на чтении, чем верить,
    // что в хранилище всегда лежит согласованная пара.
    return { comments, replies: comments && replies };
  } catch {
    return DEFAULT;
  }
}

// Значение на всю вкладку. Держим его и в памяти тоже: если хранилище недоступно, галочки
// обязаны работать хотя бы до перезагрузки. Объект пересобирается только при изменении —
// useSyncExternalStore сравнивает снимки по ссылке.
let current: SyncOptions | null = null;
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getSnapshot(): SyncOptions {
  if (current === null) current = readSaved();
  return current;
}

// Разметку статических страниц Next печатает заранее, до всякого хранилища: там всегда
// «снимать всё», а сохранённое встаёт сразу после подключения.
function getServerSnapshot(): SyncOptions {
  return DEFAULT;
}

function save(next: SyncOptions) {
  current = next;
  try {
    window.localStorage.setItem(SYNC_COMMENTS_KEY, next.comments ? "1" : "0");
    window.localStorage.setItem(SYNC_REPLIES_KEY, next.replies ? "1" : "0");
  } catch {
    // Не сохранилось — галочки всё равно работают, просто до перезагрузки страницы.
  }
  for (const onChange of listeners) onChange();
}

export type SyncOptionsState = SyncOptions & {
  setComments: (on: boolean) => void;
  setReplies: (on: boolean) => void;
};

export function useSyncOptions(): SyncOptionsState {
  const options = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Сняли «комментарии» — «ветки» гаснут и выключаются: снимать их отдельно не из чего.
  const setComments = useCallback((on: boolean) => {
    save({ comments: on, replies: on && getSnapshot().replies });
  }, []);

  const setReplies = useCallback((on: boolean) => {
    save({ comments: getSnapshot().comments, replies: on });
  }, []);

  return { ...options, setComments, setReplies };
}

// Сами галочки с подсказкой — одинаковые в обоих попапах.
// idPrefix разводит id: попапов на странице несколько (кнопка сверху и по кнопке в строке).
// allVideos/onAllVideos — третья галочка: её состояние держит попап, здесь только показ.
export function SyncOptionsFields({
  idPrefix,
  allVideos,
  onAllVideos,
}: {
  idPrefix: string;
  allVideos: boolean;
  onAllVideos: (on: boolean) => void;
}) {
  const { comments, replies, setComments, setReplies } = useSyncOptions();
  const commentsId = `${idPrefix}-comments`;
  const repliesId = `${idPrefix}-replies`;
  const allVideosId = `${idPrefix}-all-videos`;

  // Сняли «комментарии» — гаснут обе нижние галочки: без текстов снимать нечего ни в
  // ветках, ни у не наших видео. `replies` гасит сам стор, а третью — вот эта строка.
  function toggleComments(on: boolean) {
    setComments(on);
    if (!on) onAllVideos(false);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Checkbox id={commentsId} checked={comments} onCheckedChange={(v) => toggleComments(v === true)} />
        <label htmlFor={commentsId} className="cursor-pointer text-xs leading-tight">
          Снимать комментарии
        </label>
      </div>
      <div className={cn("flex items-center gap-2", !comments && "opacity-50")}>
        <Checkbox
          id={repliesId}
          checked={replies}
          disabled={!comments}
          onCheckedChange={(v) => setReplies(v === true)}
        />
        <label
          htmlFor={repliesId}
          className={cn("text-xs leading-tight", comments ? "cursor-pointer" : "cursor-not-allowed")}
        >
          Снимать ветки ответов
        </label>
      </div>
      <div className={cn("flex items-center gap-2", !comments && "opacity-50")}>
        <Checkbox
          id={allVideosId}
          checked={comments && allVideos}
          disabled={!comments}
          onCheckedChange={(v) => onAllVideos(v === true)}
        />
        <label
          htmlFor={allVideosId}
          className={cn("text-xs leading-tight", comments ? "cursor-pointer" : "cursor-not-allowed")}
        >
          Комментарии и у не наших видео
        </label>
      </div>
      <p className="text-xs leading-snug text-muted-foreground">
        Без комментариев обход в разы быстрее; ветки — самая долгая часть.
      </p>
      <p className="text-xs leading-snug text-muted-foreground">
        Обычно тексты комментариев снимаются только у наших видео; это долго.
      </p>
    </div>
  );
}
