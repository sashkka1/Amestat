"use client";

import { useCallback, useSyncExternalStore } from "react";

// Свёрнутые блоки страниц (владелец, 2026-09-09: «все блоки дашборда должны сворачиваться,
// как панель „Ход обновления"»). Один ключ — один блок; положение живёт между заходами.
//
// Приём тот же, что у площадки страниц
// (`lib/platform-filter.ts`): состояние вне React, чтение и запись в try/catch (в приватном
// режиме хранилища может не быть вовсе, и обращение к нему кидает), значение дублируется в
// памяти — свернули блок, значит он свёрнут хотя бы до перезагрузки.
//
// ⚠️ Хранится именно «свёрнуто», а не «раскрыто»: умолчание — развёрнутый блок, и пустое
// хранилище обязано значить именно его.

export const COLLAPSED_PREFIX = "amestat.collapsed.";

const collapsedNow = new Map<string, boolean>();
const listeners = new Map<string, Set<() => void>>();

function readSaved(key: string): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_PREFIX + key) === "1";
  } catch {
    return false;
  }
}

function getCollapsed(key: string): boolean {
  const known = collapsedNow.get(key);
  if (known !== undefined) return known;
  const saved = readSaved(key);
  collapsedNow.set(key, saved);
  return saved;
}

// Статические страницы Next печатает заранее, до всякого хранилища: там блок всегда
// развёрнут, а сохранённое положение встаёт сразу после подключения.
function getServerCollapsed(): boolean {
  return false;
}

function setCollapsed(key: string, next: boolean): void {
  collapsedNow.set(key, next);
  try {
    window.localStorage.setItem(COLLAPSED_PREFIX + key, next ? "1" : "0");
  } catch {
    // Не сохранилось — блок всё равно свернулся, просто до перезагрузки страницы.
  }
  const set = listeners.get(key);
  if (set) for (const onChange of set) onChange();
}

export function useCollapsed(key: string): { open: boolean; toggle: () => void } {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const set = listeners.get(key) ?? new Set<() => void>();
      listeners.set(key, set);
      set.add(onChange);
      return () => {
        set.delete(onChange);
        if (set.size === 0) listeners.delete(key);
      };
    },
    [key],
  );
  const snapshot = useCallback(() => getCollapsed(key), [key]);
  const collapsed = useSyncExternalStore(subscribe, snapshot, getServerCollapsed);
  const toggle = useCallback(() => {
    setCollapsed(key, !getCollapsed(key));
  }, [key]);
  return { open: !collapsed, toggle };
}
