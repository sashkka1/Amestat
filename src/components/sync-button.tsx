"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { LocalTime } from "@/components/local-time";
import { PlatformIcon } from "@/components/platform";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SyncLogFeed } from "@/components/sync-log-feed";
import { useSyncOptions } from "@/components/sync-options";
import {
  SyncChoiceBlock,
  SyncDepthAndMax,
  SyncGroup,
  SyncLaunchButton,
  SyncPickGroup,
  SyncSummary,
  SyncVideosGroup,
  allVideosWord,
  pickWords,
  videosWord,
  useSyncRange,
} from "@/components/sync-choice";
import { createClient } from "@/lib/supabase/client";
import { latestRun, openRequests, requestsByIds, requestSync, runsByIds } from "@/lib/api/sync";
import { useT, type TKey } from "@/lib/i18n";
import {
  matchesPlatform,
  platformFilterLabel,
  usePlatformFilter,
  type PlatformFilter,
} from "@/lib/platform-filter";
import { useIsAdmin } from "@/lib/profile-context";
import { listCreators } from "@/lib/queries";
import {
  POLL_MS,
  allVideosTail,
  allVideosText,
  depthTail,
  depthWord,
  maxVideosTail,
  maxVideosWord,
  oursOnlyText,
  phaseText,
  progressText,
  runsResult,
  stage,
  triggerText,
  unavailableText,
  videosTail,
  type Phase,
} from "@/lib/sync-phase";
import type { Creator, SyncDepth, SyncPick, SyncRun, SyncVideos } from "@/lib/types";
import { cn } from "@/lib/utils";

// Столько ждём хоть какого-то ответа. Обычно за это время база сама пишет владельцу в
// Telegram и ставит notified_at (миграция v8); таймер нужен, если бот не настроен.
const NO_ANSWER_MS = 3 * 60_000;

// Всплывашка состояния гаснет не сразу: курсор идёт от кнопки к самой всплывашке через
// зазор, и без задержки она захлопывалась бы по дороге.
const HINT_HIDE_MS = 300;

// Кого обходить: всех креаторов или только тех, что на этой странице.
type Target = "all" | "page";

// Три блока площадки идут в том же порядке, что общий переключатель страниц.
const PLATFORM_KEYS: PlatformFilter[] = ["all", "tiktok", "instagram"];

// Подсказка внутри блока площадки: одной строкой, что именно он сузит.
const PLATFORM_HINTS: Record<PlatformFilter, TKey> = {
  all: "sync.platformHintAll",
  tiktok: "sync.platformHintTiktok",
  instagram: "sync.platformHintInstagram",
};

// Хвост «· TikTok» к строке состояния и к тосту: у «Все» площадки нет — хвоста тоже.
function platformTail(filter: PlatformFilter): string {
  return filter === "all" ? "" : ` · ${platformFilterLabel(filter)}`;
}

// Последний по времени обход из пачки — его время идёт в строку «Обновлено …».
function newest(runs: SyncRun[]): SyncRun | null {
  return runs.reduce<SyncRun | null>((best, r) => {
    if (!best) return r;
    return (r.finished_at ?? r.started_at) > (best.finished_at ?? best.started_at) ? r : best;
  }, null);
}

// Кнопка «Обновить». Состояние рядом с ней не висит: время последнего обхода, фаза
// ожидания и ход показываются во всплывашке по наведению (владелец, 2026-09-09: «текст
// около кнопки не должен висеть всегда»). Без наведения о ходе говорит сама кнопка —
// крутящейся иконкой. У администратора в той же всплывашке под статусом — журнал обхода
// (`components/sync-log-feed.tsx`); у менеджера его нет, RLS его и не отдаёт.
// scope — чей обход показывать в покое: null — любой последний, иначе id креатора.
// pageCreatorIds — креаторы этой страницы для блока «Только эта страница»; null значит
// «на странице все креаторы», и тогда группы «Кого» в попапе нет.
// Попап — группы блоков: кого обойти × какая площадка × на какую глубину × сколько видео ×
// охват списка × что снимать (владелец, 2026-09-09). Блоки только выбирают; просьба уходит
// кнопкой внизу.
export function SyncButton({
  scope,
  pageCreatorIds,
  onDone,
}: {
  scope: string | null;
  pageCreatorIds: string[] | null;
  onDone: () => void;
}) {
  const t = useT();
  const [run, setRun] = useState<SyncRun | null>(null);
  // Обходы, которые идут прямо сейчас: из них строка хода — «Обновляем 3 из 10 · @…»
  // (миграция v14). Их несколько, когда сборщик развёл площадки по полосам.
  const [running, setRunning] = useState<SyncRun[]>([]);
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
  // Всплывашка состояния: открыта, пока курсор на кнопке или на ней самой. Клавиатуре и
  // телефону хватает фокуса — Tab до кнопки открывает её тем же путём.
  const [hint, setHint] = useState(false);
  const hideRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isAdmin = useIsAdmin();
  // Что снимать: галочки попапа, общие с кнопкой в строке списка.
  const { comments, replies } = useSyncOptions();
  // Третья галочка — «комментарии и у не наших видео». В отличие от двух первых, она не
  // запоминается: тяжёлый обход должен быть осознанным каждый раз, поэтому её состояние
  // живёт здесь и гаснет при каждом открытии попапа.
  const [allVideos, setAllVideos] = useState(false);
  // Кого обходить и на какую глубину. Ничего не запоминают: попап открывается «все креаторы,
  // последняя неделя» — неделя быстрее, а долгий обход должен выбираться руками.
  const [target, setTarget] = useState<Target>("all");
  const [depth, setDepth] = useState<SyncDepth>("week");
  // Даты глубины «Период» (миграция v18): своё состояние попапа, сбрасывается при открытии.
  const range = useSyncRange();
  const resetRange = range.reset;
  // Охват списка видео (миграция v17). Умолчание — «только наши»: ради экономии времени
  // охват и вводился; ежедневный обход всё равно ходит с 'all'. Тоже не запоминается.
  const [videos, setVideos] = useState<SyncVideos>("ours");
  // Потолок числа видео на креатора (миграция v19). Умолчание — null («Все»): потолок режет
  // историю, и выбираться он должен руками. Тоже не запоминается.
  const [maxVideos, setMaxVideos] = useState<number | null>(null);

  // Площадка (владелец, 2026-09-08). Попап открывается в том же положении, что общий
  // переключатель страниц, но своего выбора не запоминает и общий не двигает: это выбор
  // на одну просьбу, а не настройка.
  const { filter: pageFilter } = usePlatformFilter();
  // На карточке креатора площадка всегда «Все»: группы там нет, и общий переключатель
  // не должен молча резать «Все креаторы».
  const startPlatform: PlatformFilter = scope === null ? pageFilter : "all";
  const [platform, setPlatform] = useState<PlatformFilter>(startPlatform);
  // Площадка ушедшей просьбы: строке состояния и тосту нечего взять из базы — в sync_runs
  // площадки нет, а знать, чей обход ждём, надо.
  const [askedPlatform, setAskedPlatform] = useState<PlatformFilter>("all");
  const askedPlatformRef = useRef<PlatformFilter>("all");
  // «Все видео» ушедшей просьбы: в отличие от площадки, база его помнит, поэтому после
  // перезагрузки страницы флаг восстанавливается из самой просьбы.
  const [askedAllVideos, setAskedAllVideos] = useState(false);
  // Охват ушедшей просьбы — как и «все видео», база его помнит, поэтому после перезагрузки
  // страницы он восстанавливается из самой просьбы.
  const [askedVideos, setAskedVideos] = useState<SyncVideos>("all");
  // Хвост глубины ушедшей просьбы: «· месяц», «· 01.09–09.09» или пусто у 'all' и 'week'.
  // Готовой строкой, а не тремя полями: считать его умеет одно место — depthTail.
  const [askedDepth, setAskedDepth] = useState("");
  // Хвост потолка ушедшей просьбы: «· до 50 видео» или пусто (миграция v19). Тоже готовой
  // строкой и по той же причине — слово живёт в одном месте, maxVideosTail.
  const [askedMaxVideos, setAskedMaxVideos] = useState("");

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
    setRunning([]);
    // Площадку просьбы забираем до сброса: тост про неё ещё расскажет.
    const tail = platformTail(askedPlatformRef.current);
    askedPlatformRef.current = "all";
    setAskedPlatform("all");
    setAskedAllVideos(false);
    setAskedVideos("all");
    setAskedDepth("");
    setAskedMaxVideos("");
    const last = finished ? newest(finished) : null;
    if (last) {
      setRun(last);
      const res = runsResult(finished ?? []);
      // Хвосты берём у самих обходов: там записано, чем они шли, а не угадано попапом.
      const full =
        tail +
        depthTail(finished ?? []) +
        maxVideosTail(finished ?? []) +
        allVideosTail(finished ?? []) +
        videosTail(finished ?? []);
      if (res.ok) toast.success(res.text + full);
      else toast.error(res.text + full);
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
      setAskedAllVideos(reqs.some((r) => r.all_videos));
      setAskedVideos(reqs.every((r) => r.videos === "ours") ? "ours" : "all");
      setAskedDepth(depthTail(reqs));
      setAskedMaxVideos(maxVideosTail(reqs));
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
      // Готово, только когда завершились все: пока хоть один идёт — ждём, а его счётчики
      // показываем. Поколение уже сверено выше — закрытый обход сюда не дописывается.
      if (runs.length < runIds.length || runs.some((r) => !r.finished_at)) {
        setRunning(runs);
        return;
      }
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
      // Обход по расписанию или чужой просьбе — его ход показываем так же, как свой.
      setRunning([last]);
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
        if (runRes.data && !runRes.data.finished_at) {
          setPhase("running");
          setRunning([runRes.data]);
        }
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
        setAskedAllVideos(waitingReqs.some((r) => r.all_videos));
        setAskedVideos(waitingReqs.every((r) => r.videos === "ours") ? "ours" : "all");
        setAskedDepth(depthTail(waitingReqs));
        setAskedMaxVideos(maxVideosTail(waitingReqs));
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

  // Показать и спрятать всплывашку. Прятанье отложено на HINT_HIDE_MS: курсор переходит с
  // кнопки на саму всплывашку через зазор, и мгновенное закрытие не дало бы до неё дойти.
  const showHint = useCallback(() => {
    if (hideRef.current !== null) {
      clearTimeout(hideRef.current);
      hideRef.current = null;
    }
    setHint(true);
  }, []);
  const hideHint = useCallback(() => {
    if (hideRef.current !== null) clearTimeout(hideRef.current);
    hideRef.current = setTimeout(() => {
      hideRef.current = null;
      setHint(false);
    }, HINT_HIDE_MS);
  }, []);
  // Ушли со страницы, пока таймер тикал, — гасим его: он бы дописал состояние размонтированной
  // кнопке.
  useEffect(
    () => () => {
      if (hideRef.current !== null) clearTimeout(hideRef.current);
    },
    [],
  );

  // Открыли попап: блоки встают в умолчания (площадка — как общий переключатель), список
  // креаторов читается один раз. Не прочитался — при следующем открытии пробуем снова.
  const openChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) return;
      // Попап выбора и всплывашка состояния не висят вместе: открылся выбор — всплывашка ушла.
      if (hideRef.current !== null) {
        clearTimeout(hideRef.current);
        hideRef.current = null;
      }
      setHint(false);
      setPlatform(startPlatform);
      // Каждое открытие — с чистого листа: ни «все видео», ни глубина, ни охват, ни потолок
      // видео не наследуются от прошлой просьбы.
      setAllVideos(false);
      setTarget("all");
      setDepth("week");
      setVideos("ours");
      setMaxVideos(null);
      // Даты периода — тоже с чистого листа: последние 30 дней.
      resetRange();
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
    // Держимся за сам reset, а не за всё состояние периода: объект пересобирается на каждый
    // набранный символ в поле даты, а reset стабилен (useCallback внутри useSyncRange).
    [startPlatform, creators, loadingCreators, resetRange],
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

  // Нажали «Запустить обновление»: в просьбу уходит выбор блоков — кого обойти (target),
  // на какую глубину (depth) и что снимать. Площадка решает, чем окажется охват: «Все» шлёт
  // null (все видимые), TikTok или Instagram — явным списком id. Попап закрывается после
  // ответа, а не до него: пока идёт вставка, кнопка внизу говорит «Отправляем…».
  async function ask() {
    const creatorIds = target === "all" ? allIds : pageTargetIds;
    // Границы уходят только у глубины «Период»: у остальных база требует пустых колонок.
    const asked = depth === "range" ? (range.range ?? undefined) : undefined;
    setSending(true);
    setError(null);
    askedPlatformRef.current = platform;
    setAskedPlatform(platform);
    setAskedAllVideos(comments && videos !== "ours" && allVideos);
    setAskedVideos(videos);
    // Хвост глубины считаем тем же depthTail, что читает строки базы: строка состояния
    // должна называть просьбу так же и до того, как её оттуда перечитали.
    setAskedDepth(
      depthTail([
        {
          depth,
          depth_from: asked?.from.toISOString() ?? null,
          depth_to: asked?.to.toISOString() ?? null,
        },
      ]),
    );
    // Хвост потолка — тем же maxVideosTail, что читает строки базы, и по той же причине.
    setAskedMaxVideos(maxVideosTail([{ max_videos: maxVideos }]));
    const res = await requestSync({
      creatorIds,
      depth,
      range: asked,
      // Без comments «и у не наших» не значит ничего — гасим на всякий случай и здесь.
      pick: { comments, replies, allVideos: comments && videos !== "ours" && allVideos, videos },
      maxVideos,
    });
    setSending(false);
    setOpen(false);
    if (!res.ok) {
      // Просьба не завелась — ждать нечего, и площадка ушедшей просьбы больше не наша.
      askedPlatformRef.current = "all";
      setAskedPlatform("all");
      setAskedAllVideos(false);
      setAskedVideos("all");
      setAskedDepth("");
      setAskedMaxVideos("");
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
  // Блок «Только эта страница» нужен, лишь когда страница уже сузила список креаторов.
  const hasPageRow = pageIds !== null && pageIds.length > 0;

  // Площадка выбрана, а креаторов у неё нет — просить нечего: блоки гаснут, под ними
  // строка почему. «Нет креаторов TikTok» перекрывает страничную: пустая площадка целиком
  // пуста и на странице.
  const allEmpty = ready && allIds !== null && allIds.length === 0;
  const pageEmpty = ready && hasPageRow && pageTargetIds !== null && pageTargetIds.length === 0;
  const platformName = platform === "all" ? "" : platformFilterLabel(platform);
  const emptyNote = allEmpty
    ? t("sync.noCreatorsPlatform", { platform: platformName })
    : pageEmpty
      ? t("sync.noCreatorsPagePlatform", { platform: platformName })
      : null;
  // Пока список креаторов не прочитан, площадку применить не к чему.
  const allBlocked = !ready || allEmpty;
  const pageBlocked = !ready || pageEmpty;
  // Кнопка внизу гаснет по выбранному охвату: набор пуст или список не прочитан — просить
  // нечего, и молча отправлять пустую просьбу нельзя.
  const targetBlocked = target === "all" ? allBlocked : pageBlocked;
  // Выбран «Период», а даты не годятся: «с» не раньше «по» или поле пустое. Почему кнопка
  // гаснет, говорит строка под самими полями (`SyncDepthGroup`).
  const rangeBlocked = depth === "range" && range.range === null;
  // Сколько креаторов на странице после площадки — и в подсказке блока, и в сводке.
  const pageCount = (pageTargetIds ?? pageIds ?? []).length;
  const pick: SyncPick = { comments, replies, allVideos: comments && videos !== "ours" && allVideos, videos };

  // Чей обход идёт — подпись серым над строкой хода. Нужна, когда владелец сам ничего не
  // просил: обход мог завестись по расписанию, догоном или повтором.
  const runTrigger = phase === "running" ? triggerText(running) : null;

  // Слова ожидания: фаза плюс площадка просьбы, если она уже. В обходе — сколько сделано
  // из скольких и кого собираем сейчас (миграция v14).
  const waitText =
    phase === "running"
      ? progressText(running)
      : phase === "seen"
        ? phaseText("seen")
        : phase === "queued"
          ? // Молчание сборщика — не ошибка пользователя: цвет обычный, просьба сохранена.
            notified
            ? unavailableText()
            : late
              ? t("sync.collectorSilent")
              : phaseText("queued")
          : null;

  // Статус для всплывашки: в покое — когда обновляли и чем шёл обход, в ожидании — фаза и
  // чей это обход. Та же строка, что раньше висела слева от кнопки, слово в слово.
  const statusNode = (
    <div className="flex min-w-0 flex-col text-xs leading-tight text-muted-foreground">
      {/* Чей обход — строкой выше хода: «Обход по расписанию», «Повтор неудавшихся». */}
      {runTrigger !== null && <span>{runTrigger}</span>}
      <span>
        {error ? (
          <span className="text-destructive" title={error}>
            {t("sync.stateError")}
          </span>
        ) : waitText !== null ? (
          waitText +
          platformTail(askedPlatform) +
          askedDepth +
          askedMaxVideos +
          (askedAllVideos ? allVideosText() : "") +
          (askedVideos === "ours" ? oursOnlyText() : "")
        ) : run ? (
          <>
            {t("sync.updated")} <LocalTime iso={run.finished_at ?? run.started_at} />
            {/* Повтор через час после неудачи по расписанию — его сборщик заводит сам. */}
            {run.trigger === "retry" && ` ${t("sync.retryTail")}`}
            {/* Обход шёл не по всему списку и не по неделе: «· месяц», «· 01.09–09.09».
                Свежи только видео этого срока, остальные остались от прошлого раза. */}
            {depthTail([run])}
            {/* Обход шёл с потолком видео: «· до 50 видео». Свежи только столько самых
                новых видео, остальные остались от прошлого раза (миграция v19). */}
            {maxVideosTail([run])}
            {/* Обход шёл без текстов комментариев — счётчики свежие, а тексты остались
                от прошлого раза, и знать об этом надо до того, как их станут читать. */}
            {run.comments === false && ` · ${t("sync.noCommentsTail")}`}
            {/* Наоборот: обход шёл и по не нашим видео — тексты у них свежие, а это редкость. */}
            {run.all_videos && allVideosText()}
            {/* Обход шёл сокращённым охватом: не наши и не жёлтые видео он не смотрел,
                и их счётчики остались от прошлого раза (миграция v17). */}
            {run.videos === "ours" && oursOnlyText()}
            {run.ok === false && (
              <span className="text-destructive" title={run.error ?? undefined}>
                {` · ${t("sync.errorTail")}`}
              </span>
            )}
          </>
        ) : (
          t("sync.never")
        )}
      </span>
    </div>
  );

  return (
    // Внешний Popover — всплывашка по наведению: она висит на самой кнопке (PopoverAnchor),
    // а кнопка остаётся триггером внутреннего попапа выбора. Два корня вложены, а не стоят
    // рядом, потому что якорь у обоих один и тот же — сама кнопка.
    <Popover open={hint && !open} onOpenChange={(next) => !next && setHint(false)}>
      <PopoverAnchor asChild>
        <span
          className="inline-flex"
          onMouseEnter={showHint}
          onMouseLeave={hideHint}
          onFocus={showHint}
          onBlur={hideHint}
        >
          <Popover open={open} onOpenChange={openChange}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" disabled={sending || waiting}>
                <RefreshCwIcon data-icon="inline-start" className={cn(phase === "running" && "animate-spin")} />
                {t("sync.button")}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] gap-3">
              {/* Кого обходить. Блока «Только эта страница» нет, когда страница и так показывает
                  всех: выбирать не из чего. */}
              {hasPageRow && (
                <SyncGroup title={t("sync.groupWho")}>
                  <SyncChoiceBlock
                    label={t("sync.allCreators")}
                    hint={t("sync.allCreatorsHint")}
                    selected={target === "all"}
                    disabled={allBlocked}
                    title={allBlocked && emptyNote ? emptyNote : undefined}
                    onClick={() => setTarget("all")}
                  />
                  <SyncChoiceBlock
                    label={scope !== null ? t("sync.thisCreator") : t("sync.thisPage")}
                    hint={
                      scope !== null
                        ? t("sync.thisCreatorHint")
                        : t("sync.thisPageHint", {
                            n: pageCount,
                            creators: t.plural("creators", pageCount),
                          })
                    }
                    selected={target === "page"}
                    disabled={pageBlocked}
                    title={pageBlocked && emptyNote ? emptyNote : undefined}
                    onClick={() => setTarget("page")}
                  />
                </SyncGroup>
              )}
              {/* Какую площадку обходить. Общий переключатель страниц попап не двигает. На карточке
                  креатора группы нет (владелец, 2026-09-09): площадка у него одна, выбирать нечего. */}
              {scope === null && (
              <SyncGroup title={t("sync.groupPlatform")} cols={3}>
                {PLATFORM_KEYS.map((key) => (
                  <SyncChoiceBlock
                    key={key}
                    label={platformFilterLabel(key)}
                    hint={t(PLATFORM_HINTS[key])}
                    icon={
                      key === "all" ? undefined : (
                        <PlatformIcon
                          platform={key}
                          className={platform === key ? "text-background/70" : undefined}
                        />
                      )
                    }
                    selected={platform === key}
                    onClick={() => setPlatform(key)}
                  />
                ))}
              </SyncGroup>
              )}
              <SyncDepthAndMax depth={depth} onDepth={setDepth} range={range} maxVideos={maxVideos} onMaxVideos={setMaxVideos} />
              {/* Охват списка видео: тот же блок, что в попапе строки списка (миграция v17). */}
              <SyncVideosGroup videos={videos} onVideos={setVideos} />
              <SyncPickGroup allVideos={allVideos} onAllVideos={setAllVideos} oursOnly={videos === "ours"} />
              {/* Единственная строка объяснений под блоками: список креаторов не прочитался или
                  у выбранной площадки некого обходить. */}
              {creatorsError ? (
                <p className="text-xs leading-snug text-destructive" title={creatorsError}>
                  {t("sync.creatorsListError")}
                </p>
              ) : loadingCreators && !ready ? (
                <p className="text-xs leading-snug text-muted-foreground">{t("sync.readingCreators")}</p>
              ) : emptyNote ? (
                <p className="text-xs leading-snug text-muted-foreground">{emptyNote}</p>
              ) : null}
              {/* Подтверждение: что именно уйдёт по нажатию — теми же словами, что в хвостах
                  строки состояния. */}
              <SyncSummary
                parts={[
                  target === "all"
                    ? t("sync.allCreators")
                    : t("sync.summaryPage", { n: pageCount }),
                  platform === "all" ? null : platformFilterLabel(platform),
                  depthWord(depth, range.range?.from, range.range?.to),
                  maxVideosWord(maxVideos),
                  videosWord(pick.videos),
                  pickWords(pick),
                  pick.allVideos && allVideosWord(),
                ]}
              />
              <SyncLaunchButton
                disabled={targetBlocked || creatorsError !== null || rangeBlocked}
                sending={sending}
                onClick={() => void ask()}
              />
            </PopoverContent>
          </Popover>
        </span>
      </PopoverAnchor>
      {/* Сама всплывашка. Фокус ей не отдаём: она открывается по наведению, и утащить
          каретку со страницы наведение не должно. Пока курсор на ней — она не гаснет. */}
      <PopoverContent
        align="end"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onMouseEnter={showHint}
        onMouseLeave={hideHint}
        className={cn(
          "max-w-[calc(100vw-2rem)] gap-2",
          // У администратора внутри ещё и журнал обхода — ему нужна ширина.
          isAdmin ? "w-[30rem]" : "w-64",
        )}
      >
        {statusNode}
        {/* Ход обновления — только администратору; менеджеру лента не рендерится вовсе. */}
        {isAdmin && (
          <>
            <p className="text-xs font-medium">{t("syncLog.title")}</p>
            <SyncLogFeed scope={scope} />
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
