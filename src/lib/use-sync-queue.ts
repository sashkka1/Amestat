"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { openRequests, requestSync, requestsByIds, runsByIds } from "@/lib/api/sync";
import { createClient } from "@/lib/supabase/client";
import {
  POLL_MS,
  allVideosTail,
  progressText,
  runsResult,
  stage,
  triggerText,
  videosTail,
  type Phase,
} from "@/lib/sync-phase";
import type { SyncDepth, SyncPick, SyncRequest, SyncRun } from "@/lib/types";

// Очередь обновления для целого списка креаторов: одно состояние на всю таблицу, а не по
// кнопке на строку. Иначе каждая строка держала бы свою подписку Realtime и свой опрос —
// на полусотне креаторов это полсотни каналов и полсотни запросов раз в 15 секунд ради
// одних и тех же двух таблиц.

// Что показывать в строке: фаза (покоя здесь не бывает — строки без просьбы в карте нет),
// «недоступно» — база написала владельцу, что просьбу никто не принял, и ход обхода
// (миграция v14): чей он и сколько сделано. Оба поля null, пока обхода ещё нет.
export type RowSync = {
  phase: Exclude<Phase, "idle">;
  unavailable: boolean;
  trigger: string | null;
  progress: string | null;
};

export type SyncQueue = {
  // Только креаторы с открытой просьбой; у остальных строк кнопка в покое.
  rows: Map<string, RowSync>;
  // Попросить обход одного креатора: охват задан строкой, выбираются глубина и что снимать.
  ask: (creatorId: string, depth: SyncDepth, pick: SyncPick) => Promise<void>;
  error: string | null;
};

export function useSyncQueue(creatorIds: string[], onDone: () => void): SyncQueue {
  // Страница пересобирает массив на каждом рендере, поэтому эффекты держатся за строку.
  const key = creatorIds.join(",");
  const ids = useMemo(() => (key === "" ? [] : key.split(",")), [key]);

  // Открытые просьбы: свои и чужие — обход мог попросить другой человек или другая вкладка.
  const [reqs, setReqs] = useState<SyncRequest[]>([]);
  // Вставка ушла, id ещё не вернулись: строка обязана закрутиться сразу по нажатию.
  const [sending, setSending] = useState<string[]>([]);
  // Идущие обходы наших просьб — из них подсказка строки: «Обновляем 3 из 10 · @…».
  const [running, setRunning] = useState<SyncRun[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Читается внутри check(), но менять его при каждом изменении нельзя: на нём висят каналы.
  const watchedRef = useRef<number[]>([]);
  // Поколение: проверок идёт несколько разом (Realtime сыплет событиями, опрос тикает,
  // человек жмёт кнопку), и запоздавшая, начатая до новой просьбы, затёрла бы её строку.
  // Каждая проверка запоминает поколение на старте и после любого ожидания молча выходит,
  // если поколение сменилось.
  const genRef = useRef(0);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  // Один круг сверки: зовётся и по событию Realtime, и опросом, и сразу после просьбы.
  const check = useCallback(async () => {
    const gen = genRef.current;
    const watched = watchedRef.current;
    // Две выборки: открытые просьбы по нашим креаторам (их мог завести кто угодно) и свои
    // по id — забранную сборщиком openRequests уже не находит, а её обход ещё надо дождаться.
    const [openRes, ownRes] = await Promise.all([openRequests(ids), requestsByIds(watched)]);
    if (genRef.current !== gen) return;
    if (!openRes.ok) {
      setError(openRes.error);
      return;
    }
    if (!ownRes.ok) {
      setError(ownRes.error);
      return;
    }
    setError(null);

    // Одна и та же просьба приходит обеими выборками — строка по id кладётся последней,
    // так свежее состояние (taken_at, run_id) перекрывает то, что вернула очередь.
    const byId = new Map<number, SyncRequest>();
    for (const r of openRes.data) byId.set(r.id, r);
    for (const r of ownRes.data) byId.set(r.id, r);
    const all = [...byId.values()];

    // Сборщик мог свести несколько просьб в один обход — id повторяются.
    const runIds = [...new Set(all.flatMap((r) => (r.run_id === null ? [] : [r.run_id])))];
    let runs: SyncRun[] = [];
    if (runIds.length > 0) {
      const runRes = await runsByIds(runIds);
      if (genRef.current !== gen) return;
      if (!runRes.ok) {
        setError(runRes.error);
        return;
      }
      runs = runRes.data;
    }
    const finishedRuns = new Map(runs.flatMap((r) => (r.finished_at ? [[r.id, r] as const] : [])));

    // Просьба закрыта, когда её обход завершился. Пропавшая строка (креатора удалили)
    // тоже закрыта: ждать больше нечего.
    const open = all.filter((r) => r.run_id === null || !finishedRuns.has(r.run_id));
    const stillOpen = new Set(open.map((r) => r.id));
    const closed = watched.filter((id) => !stillOpen.has(id));

    if (genRef.current !== gen) return;
    watchedRef.current = open.map((r) => r.id);
    // Ход показывают только незакрытые обходы: у закрытых счётчики уже итоговые, и строка
    // всё равно уходит в покой. Пусто было, пусто и осталось — состояние не трогаем.
    const live = runs.filter((r) => !r.finished_at);
    setRunning((prev) => (prev.length === 0 && live.length === 0 ? prev : live));
    // Пусто было, пусто и осталось — не трогаем состояние: сверка идёт по каждому чужому
    // событию Realtime, и новый пустой массив зря перерисовывал бы всю таблицу.
    setReqs((prev) => (prev.length === 0 && open.length === 0 ? prev : open));

    if (closed.length === 0) return;
    // Просьба закрывается один раз: сверки идут пачками (событие Realtime и тик опроса
    // приходят почти вместе), и вторая, начатая до конца первой, повторила бы тост.
    genRef.current += 1;
    // Обход кончился: тост как у кнопки «Обновить» и перечитать список — колонка
    // «Обновлено» и состояние креатора приедут вместе с ним.
    const done = [
      ...new Set(
        all.flatMap((r) => (r.run_id !== null && closed.includes(r.id) ? [r.run_id] : [])),
      ),
    ].flatMap((id) => {
      const run = finishedRuns.get(id);
      return run ? [run] : [];
    });
    if (done.length > 0) {
      const res = runsResult(done);
      // Те же хвосты, что у кнопки «Обновить»: обход брал тексты и у не наших видео и шёл
      // сокращённым охватом списка.
      const tail = allVideosTail(done) + videosTail(done);
      if (res.ok) toast.success(res.text + tail);
      else toast.error(res.text + tail);
    }
    onDoneRef.current();
  }, [ids]);

  // Первое чтение и перечитывание при смене набора креаторов: не висит ли просьба с
  // прошлой загрузки страницы или из соседней вкладки.
  useEffect(() => {
    void check();
  }, [check]);

  // Одна подписка на просьбы и одна на обходы, обе на всю таблицу: строк много, а событий
  // от Realtime приходит ровно столько же, сколько пришло бы одной кнопке.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("sync-queue")
      .on("postgres_changes", { event: "*", schema: "public", table: "sync_requests" }, () => {
        void check();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "sync_runs" }, () => {
        void check();
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [check]);

  // Опрос — пока висит хоть одна просьба.
  const waiting = reqs.length > 0;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void check(), POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, check]);

  const ask = useCallback(
    async (creatorId: string, depth: SyncDepth, pick: SyncPick) => {
      setSending((prev) => (prev.includes(creatorId) ? prev : [...prev, creatorId]));
      const res = await requestSync({ creatorIds: [creatorId], depth, pick });
      setSending((prev) => prev.filter((c) => c !== creatorId));
      if (!res.ok) {
        setError(res.error);
        toast.error(res.error);
        return;
      }
      genRef.current += 1;
      watchedRef.current = [...watchedRef.current, ...res.data.ids];
      // Строку из базы ещё не читали, но знаем, какой она завелась: сборщик её не трогал.
      // Без этого между ответом на вставку и первой сверкой строка на миг выглядела бы
      // спокойной, и по ней успели бы нажать второй раз.
      const fresh: SyncRequest[] = res.data.ids.map((id) => ({
        id,
        requested_at: new Date().toISOString(),
        requested_by: "",
        creator_id: creatorId,
        seen_at: null,
        taken_at: null,
        run_id: null,
        depth,
        comments: pick.comments,
        replies: pick.replies,
        all_videos: pick.allVideos,
        videos: pick.videos,
        notified_at: null,
      }));
      setReqs((prev) => [...prev, ...fresh]);
    },
    [],
  );

  const rows = useMemo(() => {
    const byCreator = new Map<string, SyncRequest[]>();
    for (const r of reqs) {
      // Просьба «за всех» (creator_id null) относится к каждой строке списка.
      const targets = r.creator_id === null ? ids : [r.creator_id];
      for (const c of targets) {
        const list = byCreator.get(c) ?? [];
        list.push(r);
        byCreator.set(c, list);
      }
    }
    const runById = new Map(running.map((r) => [r.id, r] as const));
    const out = new Map<string, RowSync>();
    for (const [creatorId, list] of byCreator) {
      const s = stage(list);
      if (s.phase === "idle") continue;
      // Обходы этой строки: несколько просьб сборщик мог свести в один — id повторяются.
      const own = [...new Set(list.flatMap((r) => (r.run_id === null ? [] : [r.run_id])))].flatMap(
        (id) => {
          const run = runById.get(id);
          return run ? [run] : [];
        },
      );
      out.set(creatorId, {
        phase: s.phase,
        unavailable: s.notified,
        trigger: own.length > 0 ? triggerText(own) : null,
        progress: own.length > 0 ? progressText(own) : null,
      });
    }
    // Отправляем прямо сейчас — строки в базе ещё нет, но ждать её уже начали.
    for (const c of sending)
      if (!out.has(c))
        out.set(c, { phase: "queued", unavailable: false, trigger: null, progress: null });
    return out;
  }, [reqs, ids, sending, running]);

  return { rows, ask, error };
}
