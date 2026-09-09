"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { ru, type Dict } from "./ru";
import { en } from "./en";
import { ptBR } from "./pt-BR";

// Язык сайта. Русский основной, английский и бразильский португальский — переводы
// (владелец, 2026-09-09). Выбор общий на все страницы и живёт в localStorage, тем же
// приёмом, что переключатель площадки (`lib/platform-filter.ts`): хранилища может не быть
// вовсе, и обращение к нему кидает, поэтому чтение и запись в try/catch, а значение
// дублируется в памяти — переключатель обязан работать хотя бы до перезагрузки.

export type Lang = "ru" | "en" | "pt-BR";

export const LANGS: Lang[] = ["ru", "en", "pt-BR"];

export const LANG_KEY = "amestat.lang";

const DICTS: Record<Lang, Dict> = { ru, en, "pt-BR": ptBR };

// Локаль для Intl: даты и числа берут её из выбранного языка.
const LOCALES: Record<Lang, string> = { ru: "ru-RU", en: "en-US", "pt-BR": "pt-BR" };

export function localeOf(lang: Lang): string {
  return LOCALES[lang];
}

// Ключ словаря — путь через точку: "sync.phase.queued". Тип собирается из самого `ru`,
// поэтому опечатка в ключе не соберётся.
type Join<K, P> = K extends string ? (P extends string ? (P extends "" ? K : `${K}.${P}`) : never) : never;
type Paths<T> = T extends string
  ? ""
  : { [K in keyof T & string]: Join<K, Paths<T[K]>> }[keyof T & string];

export type TKey = Paths<Dict>;
export type TParams = Record<string, string | number>;

// Слова, которые склоняются по числу: три формы в словаре, правило — на язык.
export type PluralKey = keyof Dict["plural"];

// Русское правило: 1 креатор, 2–4 креатора, 5–20 креаторов. У английского и португальского
// форм две, и «few» там повторяет «many» — выбирать нечего.
function pluralForm(lang: Lang, n: number): "one" | "few" | "many" {
  const abs = Math.abs(Math.trunc(n));
  if (lang !== "ru") return abs === 1 ? "one" : "many";
  const tens = abs % 100;
  if (tens >= 11 && tens <= 14) return "many";
  const ones = abs % 10;
  if (ones === 1) return "one";
  if (ones >= 2 && ones <= 4) return "few";
  return "many";
}

function lookup(dict: Dict, key: string): string | null {
  let node: unknown = dict;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : null;
}

// Подстановка `{имя}`. Незаполненный параметр остаётся как есть — так пропажу видно.
function fill(text: string, params?: TParams): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

// Перевода нет — берём русский: словарь-источник полон по определению. Нет и там (ключ
// сочинили на ходу) — показываем сам ключ, а не пустоту.
export function translate(lang: Lang, key: TKey, params?: TParams): string {
  const text = lookup(DICTS[lang], key) ?? lookup(ru, key);
  return text === null ? key : fill(text, params);
}

export type T = ((key: TKey, params?: TParams) => string) & {
  lang: Lang;
  // Слово по числу: «креатор» / «креатора» / «креаторов». Само число не подставляется —
  // его ставит строка-хозяйка: t("sync.thisPageHint", { n, creators: t.plural("creators", n) }).
  plural: (key: PluralKey, n: number) => string;
};

// Функция перевода одна на язык: её кладут в зависимости хуков, и пересоздавать её на
// каждый рендер значило бы гонять эти хуки впустую.
const CACHE = new Map<Lang, T>();

function makeT(lang: Lang): T {
  const cached = CACHE.get(lang);
  if (cached) return cached;
  const t = ((key: TKey, params?: TParams) => translate(lang, key, params)) as T;
  t.lang = lang;
  t.plural = (key: PluralKey, n: number) => DICTS[lang].plural[key][pluralForm(lang, n)];
  CACHE.set(lang, t);
  return t;
}

function isLang(value: unknown): value is Lang {
  return value === "ru" || value === "en" || value === "pt-BR";
}

// Умолчание — язык браузера, если он один из трёх; иначе русский.
function browserLang(): Lang {
  try {
    const raw = (navigator.language || "").toLowerCase();
    if (raw.startsWith("pt")) return "pt-BR";
    if (raw.startsWith("en")) return "en";
  } catch {
    // navigator недоступен — остаётся русский.
  }
  return "ru";
}

function readSaved(): Lang {
  try {
    const raw = window.localStorage.getItem(LANG_KEY);
    return isLang(raw) ? raw : browserLang();
  } catch {
    return "ru";
  }
}

let current: Lang | null = null;
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getSnapshot(): Lang {
  if (current === null) current = readSaved();
  return current;
}

// Разметку статических страниц Next печатает заранее, до всякого хранилища: там всегда
// русский, а выбранный язык встаёт сразу после подключения.
function getServerSnapshot(): Lang {
  return "ru";
}

// Язык вне React: его читают форматирование чисел и дат (`lib/format.ts`) и модули без
// хуков — ответы операций с базой (`lib/api/*`), слова обхода (`lib/sync-phase.ts`).
// ⚠️ Перерисовку это само не вызывает: страница обязана быть подписана через useT/useLang,
// и тогда всё под ней пересчитается вместе с ней.
export function getLang(): Lang {
  return typeof window === "undefined" ? "ru" : getSnapshot();
}

// Перевод вне React — тем же словарём и тем же языком, что и в компонентах.
export function tr(key: TKey, params?: TParams): string {
  return translate(getLang(), key, params);
}

// Склонение вне React — тем же правилом языка, что и `t.plural` в компонентах.
export function trPlural(key: PluralKey, n: number): string {
  return makeT(getLang()).plural(key, n);
}

export function setLang(next: Lang): void {
  current = next;
  try {
    window.localStorage.setItem(LANG_KEY, next);
  } catch {
    // Не сохранилось — переключатель всё равно работает, просто до перезагрузки страницы.
  }
  for (const onChange of listeners) onChange();
}

export function useLang(): { lang: Lang; setLang: (next: Lang) => void } {
  const lang = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const set = useCallback((next: Lang) => setLang(next), []);
  return { lang, setLang: set };
}

export function useT(): T {
  const lang = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return useMemo(() => makeT(lang), [lang]);
}

// Короткие месяцы выбранного языка по порядку: «янв», «фев», … Их берут подписи оси и даты
// в карточках — Intl там не годится, потому что добавляет точку и «г.».
export function monthsShort(lang: Lang): string[] {
  const m = DICTS[lang].format.months;
  return [m.m1, m.m2, m.m3, m.m4, m.m5, m.m6, m.m7, m.m8, m.m9, m.m10, m.m11, m.m12];
}

// Заголовок вкладки. Статика печатает его заранее и по-русски, поэтому язык проставляется
// уже в браузере — как и `<html lang>`.
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · Amestat` : "Amestat";
  }, [title]);
}
