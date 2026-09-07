"use client";

import { useCallback, useEffect, useState } from "react";

export type Loaded<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  // Перечитать заново — вместо revalidatePath, которого в статике нет.
  reload: () => void;
};

type Result<T> = { key: string; data: T | null; error: string | null };

// Загрузка данных в браузере: loader вызывается при монтировании, при смене deps и при
// каждом reload(). Ответ устаревшего вызова выбрасывается; пока идёт новый — старые данные
// остаются на экране, loading = true.
export function useLoader<T>(loader: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<Result<T> | null>(null);
  // deps — простые значения (id, числа), поэтому ключ запроса — их JSON.
  const key = JSON.stringify([tick, ...deps]);

  useEffect(() => {
    let alive = true;
    loader().then(
      (data) => {
        if (alive) setResult({ key, data, error: null });
      },
      (e: unknown) => {
        if (alive) setResult({ key, data: null, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      alive = false;
    };
    // loader — свежая функция каждый рендер; запрос повторяется только по ключу.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const loading = result === null || result.key !== key;
  return {
    data: result?.data ?? null,
    error: loading ? null : result.error,
    loading,
    reload,
  };
}
