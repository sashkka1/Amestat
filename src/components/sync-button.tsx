"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { LocalTime } from "@/components/local-time";
import { PlatformSwitch } from "@/components/platform-switch";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SyncOptionsFields, useSyncOptions } from "@/components/sync-options";
import { createClient } from "@/lib/supabase/client";
import { latestRun, openRequests, requestsByIds, requestSync, runsByIds } from "@/lib/api/sync";
import {
  PLATFORM_FILTER_LABELS,
  matchesPlatform,
  usePlatformFilter,
  type PlatformFilter,
} from "@/lib/platform-filter";
import { listCreators } from "@/lib/queries";
import {
  PHASE_TEXT,
  POLL_MS,
  UNAVAILABLE_TEXT,
  runsResult,
  stage,
  type Phase,
} from "@/lib/sync-phase";
import type { Creator, SyncDepth, SyncRun } from "@/lib/types";
import { cn } from "@/lib/utils";

// Столько ждём хоть какого-то ответа. Обычно за это время база сама пишет владельцу в
// Telegram и ставит notified_at (миграция v8); таймер нужен, если бот не настроен.
const NO_ANSWER_MS = 3 * 60_000;

// Какую строку матрицы выбрали: всех креаторов или только тех, что на этой странице.
type Target = "all" | "page";

// Хвост «· TikTok» к строке состояния и к тосту: у «Все» площадки нет — хвоста тоже.
function platformTail(filter: PlatformFilter): string {
  return filter === "all" ? "" : ` · ${PLATFORM_FILTER_LABELS[filter]}`;
}

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
// Матрица трёхосная: кого обойти × на какую глубину × какую площадку.
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

  // Третья ось матрицы — площадка (владелец, 2026-09-08). Попап открывается в том же
  // положении, что общий переключатель страниц, но своего выбора не запоминает и общий
  // не двигает: это выбор на одну просьбу, а не настройка.
  const { filter: pageFilter } = usePlatformFilter();
  const [platform, setPlatform] = useState<PlatformFilter>(pageFilter);
  const platformState = useMemo(
    () => ({ filter: platform, setFilter: setPlatform }),
    [platform],
  );
  // Площадка ушедшей просьбы: строке состояния и тосту нечего взять из базы — в sync_runs
  // площадки нет, а знать, чей обход ждём, надо.
  const [askedPlatform, setAskedPlatform] = useState<PlatformFilter>("all");
  const askedPlatformRef = useRef<PlatformFilter>("all");

  // Список креаторов нужен, чтобы отобрать id по площадке: просьба уходит явным списком.
  // Читается один раз при открытии попапа — RLS уже отдаёт только видимых.
  const [creators, setCreators] = useState<Creator[] | null>(null);
  const [creatorsError, setCreatorsError] = useState<string | null>(null);
  const [loadingCreators, setLoadingCreators] = useState(false);

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
    // Площадку просьбы забираем до сброса: тост про неё ещё расскажет.
    const tail = platformTail(askedPlatformRef.current);
    askedPlatformRef.current = "all";
    setAskedPlatform("all");
    const last = finished ? newest(finished) : null;
    if (last) {
      setRun(last);
      const res = runsResult(finished ?? []);
      if (res.ok) toast.success(res.text + tail);
      else toast.error(res.text + tail);
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

  // Открыли попап: чипы встают в положение общего переключателя, список креаторов читается
  // один раз. Не прочитался — при следующем открытии пробуем снова.
  const openChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) return;
      setPlatform(pageFilter);
      if (creators !== null || loadingCreators) return;
      setLoadingCreators(true);
      setCreatorsError(null);
      listCreators().then(
        (list) => {
          setCreators(list);
          setLoadingCreators(false);
        },
        (e: unknown) => {
          setCreatorsError(e instanceof Error ? e.message : String(e));
          setLoadingCreators(false);
        },
      );
    },
    [pageFilter, creators, loadingCreators],
  );

  // Площадка креатора — из списка; строка страницы отбирается по ней же.
  const platformById = useMemo(
    () => new Map((creators ?? []).map((c) => [c.id, c.platform] as const)),
    [creators],
  );
  // Пока площадка «Все», список не нужен вовсе: просьба уходит как раньше.
  const ready = platform === "all" || creators !== null;
  // Набор id для строки «Все креаторы»: null — без ограничения, как было до площадок.
  const allIds = useMemo<string[] | null>(
    () =>
      platform === "all"
        ? null
        : (creators ?? []).filter((c) => matchesPlatform(platform, c.platform)).map((c) => c.id),
    [platform, creators],
  );
  // Набор id для строки «Только эта страница»: id страницы, просеянные площадкой.
  const pageTargetIds = useMemo<string[] | null>(() => {
    if (pageIds === null) return null;
    if (platform === "all") return pageIds;
    return pageIds.filter((id) => {
      const p = platformById.get(id);
      return p !== undefined && matchesPlatform(platform, p);
    });
  }, [pageIds, platform, platformById]);

  // Выбрали ячейку матрицы: кого обойти (target), на какую глубину (depth) и что снимать
  // (галочки попапа — они же уходят в просьбу). Площадка решает, чем окажется охват:
  // «Все» шлёт null (все видимые), TikTok или Instagram — явным списком id.
  async function ask(target: Target, depth: SyncDepth) {
    const creatorIds = target === "all" ? allIds : pageTargetIds;
    setOpen(false);
    setSending(true);
    setError(null);
    askedPlatformRef.current = platform;
    setAskedPlatform(platform);
    const res = await requestSync({
      creatorIds,
      depth,
      comments,
      replies,
    });
    setSending(false);
    if (!res.ok) {
      // Просьба не завелась — ждать нечего, и площадка ушедшей просьбы больше не наша.
      askedPlatformRef.current = "all";
      setAskedPlatform("all");
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

  // Площадка выбрана, а креаторов у неё нет — просить нечего: ячейки гаснут, под матрицей
  // строка почему. «Нет креаторов TikTok» перекрывает страничную: пустая площадка целиком
  // пуста и на странице.
  const allEmpty = ready && allIds !== null && allIds.length === 0;
  const pageEmpty = ready && hasPageRow && pageTargetIds !== null && pageTargetIds.length === 0;
  const platformName = platform === "all" ? "" : PLATFORM_FILTER_LABELS[platform];
  const emptyNote = allEmpty
    ? `Нет креаторов ${platformName}`
    : pageEmpty
      ? `На этой странице нет креаторов ${platformName}`
      : null;
  // Пока список креаторов не прочитан, площадку применить не к чему.
  const allBlocked = !ready || allEmpty;
  const pageBlocked = !ready || pageEmpty;

  // Слова ожидания: фаза плюс площадка просьбы, если она уже.
  const waitText =
    phase === "running"
      ? PHASE_TEXT.running
      : phase === "seen"
        ? PHASE_TEXT.seen
        : phase === "queued"
          ? // Молчание сборщика — не ошибка пользователя: цвет обычный, просьба сохранена.
            notified
            ? UNAVAILABLE_TEXT
            : late
              ? "Сборщик не отвечает, просьба сохранена: обновим, как только он проснётся"
              : PHASE_TEXT.queued
          : null;

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">
        {error ? (
          <span className="text-destructive" title={error}>
            Не удалось прочитать состояние
          </span>
        ) : waitText !== null ? (
          waitText + platformTail(askedPlatform)
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
      <Popover open={open} onOpenChange={openChange}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" disabled={sending || waiting}>
            <RefreshCwIcon data-icon="inline-start" className={cn(phase === "running" && "animate-spin")} />
            Обновить
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[21rem]">
          {/* Третья ось: какую площадку обходить. Общий переключатель страниц не двигает. */}
          <PlatformSwitch state={platformState} className="justify-between" />
          {hasPageRow ? (
            // Матрица: строки — кого обойти, столбцы — на какую глубину.
            <div className="grid grid-cols-[minmax(0,auto)_1fr_1fr] items-center gap-1.5">
              <span />
              <span className="text-center text-xs leading-tight text-muted-foreground">Всё</span>
              <span className="text-center text-xs leading-tight text-muted-foreground">
                Последняя неделя
              </span>

              <span className="pr-1 text-xs leading-tight text-muted-foreground">Все креаторы</span>
              <MatrixCell
                title="Все креаторы, всё"
                disabled={allBlocked}
                onClick={() => void ask("all", "all")}
              />
              <MatrixCell
                title="Все креаторы, последняя неделя"
                disabled={allBlocked}
                onClick={() => void ask("all", "week")}
              />

              <span className="pr-1 text-xs leading-tight text-muted-foreground">Только эта страница</span>
              <MatrixCell
                title="Только эта страница, всё"
                disabled={pageBlocked}
                onClick={() => void ask("page", "all")}
              />
              <MatrixCell
                title="Только эта страница, последняя неделя"
                disabled={pageBlocked}
                onClick={() => void ask("page", "week")}
              />
            </div>
          ) : (
            // На странице и так все креаторы — выбирать некого, остаётся глубина.
            <div className="grid grid-cols-2 gap-1.5">
              <Button variant="outline" size="sm" disabled={allBlocked} onClick={() => void ask("all", "all")}>
                Всё
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={allBlocked}
                onClick={() => void ask("all", "week")}
              >
                Последняя неделя
              </Button>
            </div>
          )}
          {creatorsError ? (
            <p className="text-xs leading-snug text-destructive" title={creatorsError}>
              Не удалось прочитать список креаторов — площадку выбрать не из чего
            </p>
          ) : loadingCreators && !ready ? (
            <p className="text-xs leading-snug text-muted-foreground">Читаем список креаторов…</p>
          ) : emptyNote ? (
            <p className="text-xs leading-snug text-muted-foreground">{emptyNote}</p>
          ) : null}
          <SyncOptionsFields idPrefix={`sync-${scope ?? "all"}`} />
          <p className="text-xs leading-snug text-muted-foreground">
            Неделя — быстрее: только видео за 7 дней, старые не пересчитываются.
          </p>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// Ячейка матрицы: что она значит, говорят подписи строки, столбца и чипов площадки.
function MatrixCell({
  title,
  disabled,
  onClick,
}: {
  title: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="w-full"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      Обновить
    </Button>
  );
}
