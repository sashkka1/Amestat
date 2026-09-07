"use client";

import { useSyncExternalStore } from "react";
import { fmtDateTime, fmtDate } from "@/lib/format";

const subscribeNoop = () => () => {};
// true только после гидрации: на сервере и при первом клиентском рендере — false.
function useHydrated() {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
}

// Дата в местном поясе. На сервере пояс другой, поэтому текст ставится только
// после гидрации — иначе React ругается на несовпадение разметки.
export function LocalTime({
  iso,
  mode = "datetime",
  fallback = "…",
}: {
  iso: string | null | undefined;
  mode?: "datetime" | "date";
  fallback?: string;
}) {
  const hydrated = useHydrated();
  if (!iso) return <span>—</span>;
  if (!hydrated) return <span>{fallback}</span>;
  return <span>{mode === "date" ? fmtDate(iso) : fmtDateTime(iso)}</span>;
}
