"use client";

import { useSyncExternalStore } from "react";
import { tr } from "@/lib/i18n";
import type { VideoState } from "./video-state";

// Две настройки полосы периода на дашборде: сравнивать ли с прошлым сроком и какие видео
// считать. Обе живут в localStorage тем же приёмом, что переключатель площадки
// (`lib/platform-filter.ts`): хранилища может не быть вовсе, и обращение к нему кидает —
// поэтому чтение и запись в try/catch, а значение дублируется в памяти: переключатель обязан
// работать хотя бы до перезагрузки. Приём тот же, поэтому здесь он вынесен в одну фабрику.

export const COMPARE_KEY = "amestat.compare";
export const SCOPE_KEY = "amestat.scope";

// Значения — строки: в хранилище всё равно ложится строка, и «выключено» лучше читать
// глазами в devtools, чем разбирать "0"/"false".
export type Compare = "on" | "off";
export type Scope = "all" | "ours";

// Порядок сегментов и умолчание — «Только наши» первым (владелец, 2026-09-09): считаем мы
// в первую очередь свои видео, а «Все видео» смотрим по желанию.
export const SCOPES: Scope[] = ["ours", "all"];

function createStore<T extends string>(key: string, values: readonly T[], fallback: T) {
  let current: T | null = null;
  const listeners = new Set<() => void>();

  function subscribe(onChange: () => void): () => void {
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }

  function getSnapshot(): T {
    if (current === null) {
      try {
        const raw = window.localStorage.getItem(key);
        current = values.includes(raw as T) ? (raw as T) : fallback;
      } catch {
        current = fallback;
      }
    }
    return current;
  }

  // Разметку статических страниц Next печатает заранее, до всякого хранилища: там всегда
  // умолчание, а сохранённое встаёт сразу после подключения.
  function getServerSnapshot(): T {
    return fallback;
  }

  function set(next: T): void {
    current = next;
    try {
      window.localStorage.setItem(key, next);
    } catch {
      // Не сохранилось — переключатель всё равно работает, просто до перезагрузки страницы.
    }
    for (const onChange of listeners) onChange();
  }

  // Имя с `use` — иначе правило хуков не признаёт функцию хуком и ругается на вызов
  // useSyncExternalStore внутри неё.
  return function useStore(): [T, (next: T) => void] {
    return [useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot), set];
  };
}

const useCompareStore = createStore<Compare>(COMPARE_KEY, ["on", "off"], "on");
const useScopeStore = createStore<Scope>(SCOPE_KEY, SCOPES, "ours");

// Сравнение с прошлым сроком. Выключено — плитки не показывают дельту, и прошлый срок
// не читается вовсе: лишний вызов creators_overview на каждую смену срока.
export function useCompare(): { on: boolean; set: (on: boolean) => void } {
  const [value, setValue] = useCompareStore();
  return { on: value === "on", set: (on: boolean) => setValue(on ? "on" : "off") };
}

export function useScope(): { scope: Scope; setScope: (next: Scope) => void } {
  const [scope, setScope] = useScopeStore();
  return { scope, setScope };
}

// 🔴 «Только наши» — это наше И жёлтое: жёлтое видео мы ведём так же, просто без подробностей
// (`lib/video-state.ts`). Отсеивается одно «не наше».
//
// ⚠️ Это же определение стоит в базе (`videos.ours or videos.watch`, миграция v22), и оно
// обязано совпадать: иначе таблица на странице и плитки над ней считали бы разные наборы.
export function matchesScope(scope: Scope, state: VideoState): boolean {
  return scope === "all" || state !== "none";
}

export function scopeLabel(scope: Scope): string {
  return scope === "all" ? tr("periodBar.scopeAll") : tr("periodBar.scopeOurs");
}
