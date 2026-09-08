"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SyncOptionsFields, useSyncOptions } from "@/components/sync-options";
import { createClient } from "@/lib/supabase/client";
import { latestRun, openRequests, requestsByIds, requestSync, runsByIds } from "@/lib/api/sync";
import {
  PHASE_TEXT,
  POLL_MS,
  UNAVAILABLE_TEXT,
  runsResult,
  stage,
  type Phase,
} from "@/lib/sync-phase";
import type { SyncDepth, SyncRun } from "@/lib/types";
import { cn } from "@/lib/utils";

// Столько ждём хоть какого-то ответа. Обычно за это время база сама пишет владельцу в
// Telegram и ставит notified_at (миграция v8); таймер нужен, если бот не настроен.
const NO_ANSWER_MS = 3 * 60_000;

// Какую строку матрицы выбрали: всех креаторов или только тех, что на этой странице.
type Target = "all" | "page";

// Последний по времени обход из пачки — его время идёт в строку «Обновлено …».
function newest(runs: SyncRun[]): SyncRun | null {
  return runs.reduce<SyncRun | null>((best, r) => {
    if (!best) return r;
    return (r.finished_at ?? r.started_at) > (best.finished_at ?? best.started_at) ? r : best;
  }, null);
}

// Кнопка «Обновить» и время последнего обхода.
// scope — чей обход показывать в покое: null — любой последний, иначе id креатора.
// pageCreatorIds — креаторы этой страницы для строки «Только эта страница»; null значит
// «на странице все креаторы», и тогда этой строки в матрице нет.
export function SyncButton({
  scope,
  pageCreatorIds,
  onDone,
}: {
  scope: string | null;
  pageCreatorIds: string[] | null;
  onDone: () => void;
}) {
  const [run, setRun] = useState<SyncRun | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [reqIds, setReqIds] = useState<number[]>([]);
  const [askedAt, setAskedAt] = useState<number | null>(null);
  const [late, setLate] = useState(false);
  // Резидент подал признак жизни / база написала владельцу — по всей пачке просьб.
  const [seenAny, setSeenAny] = useState(false);
  const [notified, setNotified] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // Что снимать: галочки попапа, общие с кнопкой в строке списка.
  const { comments, replies } = useSyncOptions();

  // Родитель пересобирает массив на каждом рендере, поэтому эффекты держатся за строку.
  const pageKey = pageCreatorIds === null ? null : pageCreatorIds.join(",");
  const pageIds = useMemo(
    () => (pageKey === null ? null : pageKey === "" ? [] : pageKey.split(",")),
    [pageKey],
  );
  const reqKey = reqIds.join(",");

  // Читаются внутри check(), но менять его при каждом изменении нельзя: на нём висят каналы.
  const reqIdsRef = useRef<number[]>([]);
  const phaseRef = useRef<Phase>("idle");
  // Поколение просьбы. Проверок может идти несколько разом (Realtime сыплет событиями, опрос
  // тикает), и запоздавшая, начатая до конца обхода, дописывала бы уже закрытое состояние
  // («В очереди…» поверх «Обновлено»). Каждая проверка запоминает поколение на старте и после
  // любого ожидания молча выходит, если поколение сменилось.
  const genRef = useRef(0);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // Обходы кончились: тост, перечитать данные страницы, вернуться в покой.
  const finish = useCallback((finished: SyncRun[] | null) => {
    genRef.current += 1;
    reqIdsRef.current = [];
    setReqIds([]);
    setAskedAt(null);
    setLate(false);
    setSeenAny(false);
    setNotified(false);
    setPhase("idle");
    const last = finished ? newest(finished) : null;
    if (last) {
      setRun(last);
      const res = runsResult(finished ?? []);
      if (res.ok) toast.success(res.text);
      else toast.error(res.text);
    }
    onDoneRef.current();
  }, []);

  // Один круг сверки состояния: зовётся и по событию Realtime, и опросом.
  const check = useCallback(async () => {
    const ids = reqIdsRef.current;
    const gen = genRef.current;

    if (ids.length > 0) {
      const reqRes = await requestsByIds(ids);
      if (genRef.current !== gen) return;
      if (!reqRes.ok) {
        setError(reqRes.error);
        return;
      }
      setError(null);
      const reqs = reqRes.data;
      // Строк нет — просьбы удалили вместе с креаторами; ждать больше нечего.
      if (reqs.length === 0) {
        finish(null);
        return;
      }
      const now = stage(reqs);
      setSeenAny(now.seenAny);
      setNotified(now.notified);
      // Забрали не всех — обхода ещё нет: либо очередь, либо резидент уже принял просьбу.
      if (now.phase !== "running") {
        setPhase(now.phase);
        return;
      }
      setPhase("running");
      setLate(false);
      // Забрали, но обход завёлся не у каждой — ждём следующего события.
      if (reqs.some((r) => r.run_id === null)) return;
      // Сборщик мог свести несколько просьб в один обход — id повторяются.
      const runIds = [...new Set(reqs.map((r) => r.run_id).filter((id): id is number => id !== null))];
      const runRes = await runsByIds(runIds);
      if (genRef.current !== gen) return;
      if (!runRes.ok) {
        setError(runRes.error);
        return;
      }
      const runs = runRes.data;
      // Готово, только когда завершились все: пока хоть один идёт — ждём.
      if (runs.length < runIds.length || runs.some((r) => !r.finished_at)) return;
      finish(runs);
      return;
    }

    // Своей просьбы нет: следим за последним обходом — он мог начаться по расписанию.
    const runRes = await latestRun(scope ?? undefined);
    if (genRef.current !== gen) return;
    if (!runRes.ok) {
      setError(runRes.error);
      return;
    }
    setError(null);
    const last = runRes.data;
    if (last && !last.finished_at) {
      setPhase("running");
      return;
    }
    if (phaseRef.current !== "idle" && last?.finished_at) {
      finish([last]);
      return;
    }
    setRun(last);
  }, [scope, finish]);

  // Первое чтение: когда обновлялось и не висит ли просьба с прошлой загрузки страницы.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [runRes, openRes] = await Promise.all([latestRun(scope ?? undefined), openRequests(pageIds)]);
      if (!alive) return;
      if (!runRes.ok) setError(runRes.error);
      else {
        setRun(runRes.data);
        if (runRes.data && !runRes.data.finished_at) setPhase("running");
      }
      if (!openRes.ok) {
        setError(openRes.error);
        return;
      }
      const waitingReqs = openRes.data;
      if (waitingReqs.length > 0) {
        const ids = waitingReqs.map((r) => r.id);
        reqIdsRef.current = ids;
        setReqIds(ids);
        // Счёт «нет ответа» — от самой свежей просьбы пачки.
        setAskedAt(Math.max(...waitingReqs.map((r) => new Date(r.requested_at).getTime())));
        const now = stage(waitingReqs);
        setSeenAny(now.seenAny);
        setNotified(now.notified);
        setPhase(now.phase);
      }
    })();
    return () => {
      alive = false;
    };
  }, [scope, pageIds]);

  // Обходы: любая строка sync_runs может оказаться нашей — сверяемся.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`sync-runs-${scope ?? "all"}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "sync_runs" }, () => {
        void check();
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [scope, check]);

  // Свои просьбы: UPDATE приходит, когда сборщик поставил taken_at и run_id. Просьб может
  // быть много (по одной на креатора) — одна подписка на всю пачку, фильтром `id=in.(…)`:
  // такой формат Postgres Changes понимает (см. RealtimePostgresChangesFilterOperator).
  useEffect(() => {
    if (reqKey === "") return;
    const supabase = createClient();
    const channel = supabase
      .channel(`sync-requests-${reqKey.split(",")[0]}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "sync_requests", filter: `id=in.(${reqKey})` },
        () => {
          void check();
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [reqKey, check]);

  // Опрос — пока не вернулись в покой.
  useEffect(() => {
    if (phase === "idle") return;
    const timer = setInterval(() => void check(), POLL_MS);
    return () => clearInterval(timer);
  }, [phase, check]);

  // Запасной случай: за три минуты не пришло ни seen_at, ни notified_at — значит и бот
  // не настроен. Просьба остаётся в базе, кнопка остаётся выключенной, меняется только текст.
  useEffect(() => {
    if (phase !== "queued" || notified || seenAny || askedAt === null) return;
    const left = Math.max(0, askedAt + NO_ANSWER_MS - Date.now());
    const timer = setTimeout(() => setLate(true), left);
    return () => clearTimeout(timer);
  }, [phase, notified, seenAny, askedAt]);

  // Выбрали ячейку матрицы: кого обойти (target), на какую глубину (depth) и что снимать
  // (галочки попапа — они же уходят в просьбу).
  async function ask(target: Target, depth: SyncDepth) {
    setOpen(false);
    setSending(true);
    setError(null);
    const res = await requestSync({
      creatorIds: target === "all" ? null : pageIds,
      depth,
      comments,
      replies,
    });
    setSending(false);
    if (!res.ok) {
      setError(res.error);
      toast.error(res.error);
      return;
    }
    genRef.current += 1;
    reqIdsRef.current = res.data.ids;
    setReqIds(res.data.ids);
    setAskedAt(Date.now());
    setLate(false);
    setSeenAny(false);
    setNotified(false);
    setPhase("queued");
  }

  // Просьба жива, пока не кончился обход: ни молчание сборщика, ни письмо владельцу
  // кнопку не освобождают — иначе на одну и ту же работу накопится очередь просьб.
  const waiting = phase !== "idle";
  // Строка «Только эта страница» нужна, лишь когда страница уже сузила список креаторов.
  const hasPageRow = pageIds !== null && pageIds.length > 0;

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">
        {error ? (
          <span className="text-destructive" title={error}>
            Не удалось прочитать состояние
          </span>
        ) : phase === "running" ? (
          PHASE_TEXT.running
        ) : phase === "seen" ? (
          PHASE_TEXT.seen
        ) : phase === "queued" ? (
          // Молчание сборщика — не ошибка пользователя: цвет обычный, просьба сохранена.
          notified ? (
            UNAVAILABLE_TEXT
          ) : late ? (
            "Сборщик не отвечает, просьба сохранена: обновим, как только он проснётся"
          ) : (
            PHASE_TEXT.queued
          )
        ) : run ? (
          <>
            Обновлено <LocalTime iso={run.finished_at ?? run.started_at} />
            {/* Повтор через час после неудачи по расписанию — его сборщик заводит сам. */}
            {run.trigger === "retry" && " (повтор)"}
            {/* Обход шёл без текстов комментариев — счётчики свежие, а тексты остались
                от прошлого раза, и знать об этом надо до того, как их станут читать. */}
            {run.comments === false && " · без комментариев"}
            {run.ok === false && (
              <span className="text-destructive" title={run.error ?? undefined}>
                {" "}
                · ошибка
              </span>
            )}
          </>
        ) : (
          "ещё не обновлялось"
        )}
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" disabled={sending || waiting}>
            <RefreshCwIcon data-icon="inline-start" className={cn(phase === "running" && "animate-spin")} />
            Обновить
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[21rem]">
          {hasPageRow ? (
            // Матрица: строки — кого обойти, столбцы — на какую глубину.
            <div className="grid grid-cols-[minmax(0,auto)_1fr_1fr] items-center gap-1.5">
              <span />
              <span className="text-center text-xs leading-tight text-muted-foreground">Всё</span>
              <span className="text-center text-xs leading-tight text-muted-foreground">
                Последняя неделя
              </span>

              <span className="pr-1 text-xs leading-tight text-muted-foreground">Все креаторы</span>
              <MatrixCell title="Все креаторы, всё" onClick={() => void ask("all", "all")} />
              <MatrixCell title="Все креаторы, последняя неделя" onClick={() => void ask("all", "week")} />

              <span className="pr-1 text-xs leading-tight text-muted-foreground">Только эта страница</span>
              <MatrixCell title="Только эта страница, всё" onClick={() => void ask("page", "all")} />
              <MatrixCell
                title="Только эта страница, последняя неделя"
                onClick={() => void ask("page", "week")}
              />
            </div>
          ) : (
            // На странице и так все креаторы — выбирать некого, остаётся глубина.
            <div className="grid grid-cols-2 gap-1.5">
              <Button variant="outline" size="sm" onClick={() => void ask("all", "all")}>
                Всё
              </Button>
              <Button variant="outline" size="sm" onClick={() => void ask("all", "week")}>
                Последняя неделя
              </Button>
            </div>
          )}
          <SyncOptionsFields idPrefix={`sync-${scope ?? "all"}`} />
          <p className="text-xs leading-snug text-muted-foreground">
            Неделя — быстрее: только видео за 7 дней, старые не пересчитываются.
          </p>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// Ячейка матрицы: что она значит, говорят подписи строки и столбца.
function MatrixCell({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" className="w-full" title={title} aria-label={title} onClick={onClick}>
      Обновить
    </Button>
  );
}
