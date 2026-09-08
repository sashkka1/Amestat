"use client";

import { useMemo, useState } from "react";
import {
  fromDateInputValue,
  previousRange,
  resolvePeriod,
  toDateInputValue,
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
export function usePeriod(earliest: Date): PeriodState {
  const [key, setKey] = useState<PeriodKey>("7d");
  const [customFrom, setCustomFrom] = useState(() =>
    toDateInputValue(new Date(Date.now() - 7 * 86_400_000)),
  );
  const [customTo, setCustomTo] = useState(() => toDateInputValue(new Date()));

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

  return {
    key,
    setKey,
    customFrom,
    customTo,
    setCustom: (f, t) => {
      setCustomFrom(f);
      setCustomTo(t);
    },
    range,
    previous,
  };
}
