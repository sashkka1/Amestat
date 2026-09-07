"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LocalTime } from "@/components/local-time";
import { createClient } from "@/lib/supabase/client";
import { latestRun, pendingRequestSince } from "@/lib/queries";
import { requestSync } from "@/lib/api/sync";
import type { SyncRun } from "@/lib/types";
import { cn } from "@/lib/utils";

const POLL_MS = 20_000;
const GIVE_UP_MS = 10 * 60_000;

// Блок «Обновлено: … · ✓» и кнопка запроса к сборщику. Один и тот же на списке
// («Обновить всё», creatorId null) и на карточке («Обновить этого»).
// Последний обход и незакрытую просьбу читает сам при монтировании.
export function SyncControl({
  creatorId,
  buttonLabel,
  onSynced,
  compact = false,
}: {
  creatorId: string | null;
  buttonLabel: string;
  // Обход закончился после нашей просьбы — страница перечитывает данные.
  onSynced?: () => void;
  compact?: boolean;
}) {
  const [run, setRun] = useState<SyncRun | null>(null);
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [sending, setSending] = useState(false);

  // Актуальное «с какого момента ждём» для колбэков realtime и опроса.
  const pendingRef = useRef<number | null>(null);
  useEffect(() => {
    pendingRef.current = pendingSince;
  }, [pendingSince]);

  const onSyncedRef = useRef(onSynced);
  useEffect(() => {
    onSyncedRef.current = onSynced;
  }, [onSynced]);

  // Пришёл свежий обход: если он закончился после нашего запроса — ожидание снято.
  const applyRun = useCallback((fresh: SyncRun) => {
    setRun(fresh);
    const since = pendingRef.current;
    if (since === null || !fresh.finished_at) return;
    if (new Date(fresh.started_at).getTime() >= since - 60_000) {
      pendingRef.current = null;
      setPendingSince(null);
      setTimedOut(false);
      onSyncedRef.current?.();
      if (fresh.ok) toast.success("Обновлено");
      else toast.error(`Обход с ошибкой: ${fresh.error ?? "без текста"}`);
    }
  }, []);

  const refreshRun = useCallback(async () => {
    const data = await latestRun(createClient());
    if (data) applyRun(data);
  }, [applyRun]);

  // Первое чтение: последний обход и незакрытая просьба (чтобы после перезагрузки
  // кнопка снова показала «Запрос отправлен…»).
  useEffect(() => {
    let alive = true;
    const supabase = createClient();
    void Promise.all([latestRun(supabase), pendingRequestSince(supabase, creatorId)]).then(
      ([r, since]) => {
        if (!alive) return;
        setRun(r);
        if (since) {
          const t = new Date(since).getTime();
          pendingRef.current = t;
          setPendingSince(t);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [creatorId]);

  // Realtime: любое изменение sync_runs → перечитать последний обход.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("sync_runs_watch")
      .on("postgres_changes", { event: "*", schema: "public", table: "sync_runs" }, () => {
        void refreshRun();
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [refreshRun]);

  // Запасной опрос раз в 20 с, пока ждём; через 10 минут сдаёмся.
  useEffect(() => {
    if (pendingSince === null) return;
    const id = setInterval(() => {
      if (Date.now() - pendingSince > GIVE_UP_MS) {
        pendingRef.current = null;
        setPendingSince(null);
        setTimedOut(true);
        return;
      }
      void refreshRun();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [pendingSince, refreshRun]);

  async function onClick() {
    setSending(true);
    setTimedOut(false);
    const res = await requestSync(creatorId);
    setSending(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    const now = Date.now();
    pendingRef.current = now;
    setPendingSince(now);
  }

  const pending = pendingSince !== null;
  const running = run !== null && run.finished_at === null;

  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1", compact ? "text-xs" : "text-sm")}>
      <div className="text-muted-foreground">
        {timedOut ? (
          <span className="text-destructive">Сборщик не ответил — включён ли Sashboard?</span>
        ) : running || (pending && !run) ? (
          <span>Обновляется…</span>
        ) : run ? (
          <span>
            Обновлено: <LocalTime iso={run.finished_at} /> ·{" "}
            {run.ok ? (
              <span className="text-emerald-600">✓</span>
            ) : (
              <span className="text-destructive">ошибка{run.error ? `: ${run.error}` : ""}</span>
            )}
            {run.creators_failed > 0 && (
              <span className="text-destructive"> · не удалось: {run.creators_failed}</span>
            )}
          </span>
        ) : (
          <span>Ещё не обновлялось</span>
        )}
      </div>
      <Button
        size={compact ? "sm" : "default"}
        variant="outline"
        onClick={onClick}
        disabled={pending || sending}
      >
        <RefreshCwIcon className={cn(pending && "animate-spin")} data-icon="inline-start" />
        {pending ? "Запрос отправлен…" : sending ? "Отправляем…" : buttonLabel}
      </Button>
    </div>
  );
}
