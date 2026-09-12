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
// ⚠️ Хранится именно «свёрнуто», а не «раскрыто»: обычное умолчание — развёрнутый блок.
//
// ⚠️ Блок может проситься свёрнутым с самого начала (`defaultCollapsed`) — так стоит матрица
// «кто кого комментировал» на дашборде (владелец, 2026-09-12). Поэтому «ничего не сохранено»
// и «сохранено „развёрнуто"» — РАЗНЫЕ вещи: первое отдаёт умолчание блока, второе — выбор
// владельца. Сведи их к одному `=== "1"`, и раскрытая владельцем матрица сворачивалась бы
// обратно при каждой загрузке страницы.

export const COLLAPSED_PREFIX = "amestat.collapsed.";

const collapsedNow = new Map<string, boolean>();
const listeners = new Map<string, Set<() => void>>();

function readSaved(key: string): boolean | null {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_PREFIX + key);
    return raw === null ? null : raw === "1";
  } catch {
    return null;
  }
}

function getCollapsed(key: string, byDefault: boolean): boolean {
  const known = collapsedNow.get(key);
  if (known !== undefined) return known;
  const saved = readSaved(key) ?? byDefault;
  collapsedNow.set(key, saved);
  return saved;
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

// `defaultCollapsed` — каким блок встаёт, пока владелец его не трогал. Статические страницы
// Next печатает заранее, до всякого хранилища: там блок стоит в этом самом умолчании, а
// сохранённое положение встаёт сразу после подключения.
export function useCollapsed(
  key: string,
  defaultCollapsed = false,
): { open: boolean; toggle: () => void } {
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
  const snapshot = useCallback(() => getCollapsed(key, defaultCollapsed), [key, defaultCollapsed]);
  const server = useCallback(() => defaultCollapsed, [defaultCollapsed]);
  const collapsed = useSyncExternalStore(subscribe, snapshot, server);
  const toggle = useCallback(() => {
    setCollapsed(key, !getCollapsed(key, defaultCollapsed));
  }, [key, defaultCollapsed]);
  return { open: !collapsed, toggle };
}
