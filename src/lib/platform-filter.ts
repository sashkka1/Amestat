"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { Platform } from "./types";

// Переключатель площадки над страницей: «Все» / «TikTok» / «Instagram» (владелец, 2026-09-08).
// Выбор общий для всех страниц — он лежит в localStorage, поэтому дашборд и «Креаторы»
// открываются в одном положении. Разные вкладки друг друга не догоняют, и это нормально:
// договорённость — «при смене в одной вкладке другая не обязана обновляться».

export type PlatformFilter = "all" | "tiktok" | "instagram";

export const PLATFORM_FILTER_KEY = "amestat.platform";

// Подписи кнопок переключателя. «Все» без значка — площадки у него нет.
export const PLATFORM_FILTER_LABELS: Record<PlatformFilter, string> = {
  all: "Все",
  tiktok: "TikTok",
  instagram: "Instagram",
};

// Проходит ли строка через фильтр. Чистая: ею фильтруются и креаторы, и всё, что за них
// цепляется — сводка, видео, лучшие креаторы.
export function matchesPlatform(filter: PlatformFilter, platform: Platform): boolean {
  return filter === "all" || filter === platform;
}

function isFilter(value: unknown): value is PlatformFilter {
  return value === "all" || value === "tiktok" || value === "instagram";
}

// Хранилища может не быть (приватный режим, запрет на сайт), и оно кидает прямо на
// обращении — поэтому и чтение, и запись в try/catch. Не прочиталось — значит «Все».
function readSaved(): PlatformFilter {
  try {
    const raw = window.localStorage.getItem(PLATFORM_FILTER_KEY);
    return isFilter(raw) ? raw : "all";
  } catch {
    return "all";
  }
}

// Значение на всю вкладку: одно на страницу-хозяйку и на все, куда перешли без перезагрузки.
// Держим его и в памяти тоже — если хранилище недоступно, переключатель обязан работать
// хотя бы до перезагрузки, а не застревать на «Все».
let current: PlatformFilter | null = null;
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getSnapshot(): PlatformFilter {
  if (current === null) current = readSaved();
  return current;
}

// Разметку статических страниц Next печатает заранее, до всякого хранилища: там всегда «Все»,
// а сохранённое встаёт сразу после подключения. Отдельного эффекта для этого не нужно.
function getServerSnapshot(): PlatformFilter {
  return "all";
}

export type PlatformFilterState = {
  filter: PlatformFilter;
  setFilter: (next: PlatformFilter) => void;
};

export function usePlatformFilter(): PlatformFilterState {
  const filter = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setFilter = useCallback((next: PlatformFilter) => {
    current = next;
    try {
      window.localStorage.setItem(PLATFORM_FILTER_KEY, next);
    } catch {
      // Не сохранилось — переключатель всё равно работает, просто до перезагрузки страницы.
    }
    for (const onChange of listeners) onChange();
  }, []);

  return { filter, setFilter };
}
