"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PlatformChip } from "@/components/platform";
import { Button } from "@/components/ui/button";
import { fmtTimeSec } from "@/lib/format";
import { SYNC_LOG_PAGE, latestRun, syncLog } from "@/lib/api/sync";
import { useT } from "@/lib/i18n";
import { useIsAdmin } from "@/lib/profile-context";
import { createClient } from "@/lib/supabase/client";
import { SYNC_LOG_POLL_MS, splitPlatform, unitsText } from "@/lib/sync-log";
import type { SyncLogRow, SyncRun } from "@/lib/types";
import { cn } from "@/lib/utils";

// Лента «Ход обновления» — только администратору (владелец, 2026-09-09: «мне нужно больше
// лога по обновлению, но только от лица администратора; у менеджеров такого нет»). Строки
// пишет сборщик в sync_log по мере работы; RLS пускает читать только админа, и у менеджера
// лента не рендерится вовсе — значит и запросов к таблице он не делает.
//
// ⚠️ Своей раскладки у ленты нет: она живёт во всплывашке кнопки «Обновить»
// (`components/sync-button.tsx`, владелец 2026-09-09 — «ход обновления переезжает туда же»).
// Читает она, пока смонтирована, то есть пока всплывашка открыта: прежняя сворачиваемая
// панель со своим ключом в localStorage больше не нужна.
//
// Роль решается здесь, до всяких состояний: сама лента — отдельный компонент ниже, и у
// менеджера он не монтируется, а не «монтируется и молчит».
export function SyncLogFeed({ scope }: { scope: string | null }) {
  const isAdmin = useIsAdmin();
  if (!isAdmin) return null;
  return <AdminSyncLog scope={scope} />;
}

// Прокрутка считается «внизу» с запасом: у последней строки бывает дробная высота.
const STICK_PX = 24;

// Строки не повторяются: ключ — id. Realtime и опрос приходят почти вместе, и одна и та же
// страница журнала может приехать дважды.
function mergeRows(prev: SyncLogRow[], page: SyncLogRow[]): SyncLogRow[] {
  if (page.length === 0) return prev;
  const seen = new Set(prev.map((r) => r.id));
  const add = page.filter((r) => !seen.has(r.id));
  return add.length === 0 ? prev : [...prev, ...add];
}

function AdminSyncLog({ scope }: { scope: string | null }) {
  const t = useT();
  const [run, setRun] = useState<SyncRun | null>(null);
  // Первое чтение обхода прошло: до него не пишем «обходов ещё не было».
  const [ready, setReady] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [rows, setRows] = useState<SyncLogRow[]>([]);
  const [logError, setLogError] = useState<string | null>(null);
  // Страница пришла полной — значит журнал длиннее прочитанного.
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);

  // Какой обход сейчас на экране и до какой строки он прочитан. В рефах, потому что их
  // читают обработчики Realtime и таймер опроса, а пересоздавать их из-за этого нельзя.
  const runIdRef = useRef<number | null>(null);
  const lastIdRef = useRef(0);
  // Поколение обхода: сменился обход — все запоздавшие чтения журнала выходят молча, иначе
  // строки прошлого обхода дописались бы к новому (тот же приём, что genRef у SyncButton).
  const genRef = useRef(0);
  // Две страницы разом не тянем: событий Realtime приходит по нескольку подряд. Попавший на
  // занятое чтение запрос не теряется, а помечается здесь и повторяется, когда чтение
  // закончилось: иначе смена обхода посреди чтения оставила бы ленту пустой до опроса.
  const busyRef = useRef(false);
  const pendingRef = useRef<boolean | null>(null);

  // Какой обход показывать: идущий сейчас, иначе последний завершённый. На карточке креатора
  // — с учётом scope, ровно как выбирает время «Обновлено» кнопка обновления.
  const readRun = useCallback(async () => {
    const res = await latestRun(scope ?? undefined);
    setReady(true);
    if (!res.ok) {
      setRunError(res.error);
      return;
    }
    setRunError(null);
    const next = res.data;
    setRun(next);
    const nextId = next?.id ?? null;
    if (nextId === runIdRef.current) return;
    // Начался новый обход — лента переключается на него сама, журнал прошлого не тащим.
    runIdRef.current = nextId;
    genRef.current += 1;
    lastIdRef.current = 0;
    setRows([]);
    setMore(false);
    setLogError(null);
  }, [scope]);

  // Дочитать журнал с того места, где остановились. all — дочитать целиком (кнопка внизу),
  // иначе одна страница: этого хватает и первому показу, и хвосту идущего обхода.
  const loadLog = useCallback(async function load(all: boolean): Promise<void> {
    const runId = runIdRef.current;
    if (runId === null) return;
    if (busyRef.current) {
      // Занято — не теряем просьбу: «дочитать целиком» перебивает обычную страницу.
      pendingRef.current = all || (pendingRef.current ?? false);
      return;
    }
    busyRef.current = true;
    const gen = genRef.current;
    if (all) setLoadingAll(true);
    else if (lastIdRef.current === 0) setLoading(true);
    try {
      for (;;) {
        const res = await syncLog(runId, { after: lastIdRef.current });
        // Обход сменился, пока читали, — эти строки уже не про то, что на экране.
        if (genRef.current !== gen) return;
        if (!res.ok) {
          setLogError(res.error);
          return;
        }
        setLogError(null);
        const page = res.data;
        if (page.length > 0) {
          lastIdRef.current = page[page.length - 1].id;
          setRows((prev) => mergeRows(prev, page));
        }
        const full = page.length === SYNC_LOG_PAGE;
        setMore(full);
        if (!all || !full) return;
      }
    } finally {
      busyRef.current = false;
      setLoading(false);
      setLoadingAll(false);
      const again = pendingRef.current;
      pendingRef.current = null;
      if (again !== null) void load(again);
    }
  }, []);

  // Первое чтение и перечитывание при смене страницы (scope). Обёртка не для красоты:
  // состояние меняется по ответу базы, а не в теле эффекта.
  useEffect(() => {
    void (async () => {
      await readRun();
    })();
  }, [readRun]);

  // Обходы: любая строка sync_runs может оказаться той, что показываем, — сверяемся.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`sync-log-runs-${scope ?? "all"}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "sync_runs" }, () => {
        void readRun();
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [scope, readRun]);

  const runId = run?.id ?? null;
  const finishedAt = run?.finished_at ?? null;
  const running = run !== null && !run.finished_at;

  // Обход завершился — дочитываем ещё раз: последние строки могли прийти между
  // предпоследним чтением и концом обхода, а опрос после конца уже не тикает.
  useEffect(() => {
    if (runId === null) return;
    void (async () => {
      await loadLog(false);
    })();
  }, [runId, finishedAt, loadLog]);

  // Новые строки идущего обхода. Фильтр по run_id — чтобы не будить ленту чужими вставками.
  useEffect(() => {
    if (!running || runId === null) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`sync-log-${runId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "sync_log", filter: `run_id=eq.${runId}` },
        () => {
          void loadLog(false);
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [running, runId, loadLog]);

  // Опрос, пока обход идёт: Realtime днём отваливался, и без опроса лента замирала бы на
  // середине обхода.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      void readRun();
      void loadLog(false);
    }, SYNC_LOG_POLL_MS);
    return () => clearInterval(timer);
  }, [running, readRun, loadLog]);

  // Автопрокрутка вниз — пока владелец сам не отлистал вверх. Отлистал обратно к низу —
  // прокрутка снова ведёт себя как лента.
  const boxRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const onScroll = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
  }, []);
  // Пошёл новый обход — лента опять ведёт вниз, даже если её отлистали вверх.
  useEffect(() => {
    stickRef.current = true;
  }, [runId]);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [rows]);

  // Кнопка «показать целиком» — у завершённого обхода, журнал которого длиннее страницы.
  // У идущего её нет: там хвост дочитывается сам, по событию и по опросу.
  const canLoadAll = more && run !== null && run.finished_at !== null;

  // Что написать вместо строк журнала. Ошибка чтения обхода важнее пустоты: «обходов ещё не
  // было» при неудачном запросе — прямая неправда.
  const emptyText = runError
    ? t("syncLog.emptyRunError")
    : !ready
      ? t("common.reading")
      : run === null
        ? t("syncLog.emptyNoRuns")
        : loading
          ? t("syncLog.emptyReadingLog")
          : t("syncLog.emptyNothing");

  return (
    <div className="flex flex-col gap-2">
      {logError && (
        <p className="text-xs leading-snug text-destructive" title={logError}>
          {t("syncLog.logError")}
        </p>
      )}
      <div
        ref={boxRef}
        onScroll={onScroll}
        className="max-h-[320px] overflow-y-auto rounded-lg bg-muted/40 px-3 py-2"
      >
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">{emptyText}</p>
        ) : (
          <ol className="flex flex-col gap-0.5">
            {rows.map((row) => (
              <LogLine key={row.id} row={row} />
            ))}
          </ol>
        )}
      </div>
      {canLoadAll && (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loadingAll}
            onClick={() => void loadLog(true)}
          >
            {loadingAll ? t("common.reading") : t("syncLog.showAll")}
          </Button>
        </div>
      )}
    </div>
  );
}

// Одна строка журнала: время серым, чип площадки (из префикса `[tt]`/`[ig]`), текст,
// а следом — что стоила операция, если сборщик это записал.
function LogLine({ row }: { row: SyncLogRow }) {
  const { platform, text } = splitPlatform(row.text);
  const units = unitsText(row);
  return (
    <li className="flex items-start gap-2 leading-snug">
      <span className="shrink-0 pt-px font-mono text-[11px] text-muted-foreground tabular-nums">
        {fmtTimeSec(row.at)}
      </span>
      {platform && (
        <span className="shrink-0 pt-px">
          <PlatformChip platform={platform} />
        </span>
      )}
      <span
        className={cn(
          // pre-wrap: сборщик отбивает вложенные строки пробелами, и этот отступ — часть
          // смысла («строка креатора» и под ней её подробности).
          "min-w-0 flex-1 text-xs break-words whitespace-pre-wrap",
          row.level === "error" && "text-destructive",
          row.level === "warn" && "text-amber-600 dark:text-amber-400",
        )}
      >
        {text}
        {units && <span className="text-muted-foreground"> · {units}</span>}
      </span>
    </li>
  );
}
