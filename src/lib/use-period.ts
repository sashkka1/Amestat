"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { setPeriodPrefs, usePeriodPrefs } from "./dashboard-prefs";
import { earliestPublished } from "./queries";
import {
  fromDateInputValue,
  previousRange,
  resolvePeriod,
  type PeriodKey,
  type PeriodRange,
} from "./period";

export type PeriodState = {
  key: PeriodKey;
  setKey: (k: PeriodKey) => void;
  customFrom: string;
  customTo: string;
  setCustom: (from: string, to: string) => void;
  // null — выбран «свой срок», а даты ещё не годятся.
  range: PeriodRange | null;
  previous: PeriodRange | null;
};

// Срок по умолчанию — 7 дней (владелец, 2026-09-08). «Всё время» отсчитывается от
// самой ранней даты добавления: раньше неё данных нет.
//
// 🔴 Выбор живёт не в состоянии страницы, а в общем сторе (`lib/dashboard-prefs.ts`,
// localStorage `amestat.period`): один срок на весь сайт, переход между страницами его не
// сбрасывает. Хук у каждой страницы свой, но читают они одно и то же значение, поэтому
// полоса периода и содержимое под ней не могут разойтись.
//
// ⚠️ Границы считаются здесь, а не хранятся: «7 дней» — это семь дней назад ОТ СЕЙЧАС.
// `earliest` у страниц разный (весь список креаторов против одного), и на «Всё время» срок
// у них поэтому свой — это не рассинхрон, а разный смысл слова «всё».
export function usePeriod(earliest: Date): PeriodState {
  const prefs = usePeriodPrefs();
  const { key, from: customFrom, to: customTo } = prefs;

  const setKey = useCallback((k: PeriodKey) => setPeriodPrefs({ ...prefs, key: k }), [prefs]);
  const setCustom = useCallback(
    (from: string, to: string) => setPeriodPrefs({ ...prefs, from, to }),
    [prefs],
  );

  const earliestMs = earliest.getTime();
  const range = useMemo(
    () =>
      resolvePeriod(key, new Date(), new Date(earliestMs), {
        from: fromDateInputValue(customFrom),
        to: fromDateInputValue(customTo),
      }),
    [key, customFrom, customTo, earliestMs],
  );

  const previous = useMemo(() => (range ? previousRange(range) : null), [range]);

  return { key, setKey, customFrom, customTo, setCustom, range, previous };
}

/**
 * С какого дня начинать «Всё время»: самая ранняя публикация среди видимых видео.
 * ⚠️ Раньше опорой была дата заведения креатора — но креатора заводят сегодня, а статистика
 * считается по дате публикации (v21), и весь его архив оказывался старше периода: «Всё время»
 * показывало пустоту (владелец, 2026-09-10). Пока запрос не вернулся или видео нет вовсе —
 * прежняя опора, чтобы срок не прыгал.
 */
export function useEarliestPublished(fallback: Date, creatorId?: string): Date {
  const [found, setFound] = useState<Date | null>(null);
  useEffect(() => {
    let alive = true;
    earliestPublished(creatorId).then(
      (d) => {
        if (alive && d) setFound(d);
      },
      () => {
        // Не прочиталось — остаёмся на прежней опоре.
      },
    );
    return () => {
      alive = false;
    };
  }, [creatorId]);
  const foundMs = found?.getTime() ?? null;
  const fallbackMs = fallback.getTime();
  return useMemo(() => (foundMs === null ? new Date(fallbackMs) : new Date(foundMs)), [foundMs, fallbackMs]);
}
