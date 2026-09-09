import { createClient } from "@/lib/supabase/client";
import type {
  SyncDepth,
  SyncLogRow,
  SyncPick,
  SyncRequest,
  SyncRequestInsert,
  SyncRun,
} from "@/lib/types";
import { RANGE_REQUIRED } from "@/lib/sync-phase";
import { fail, type ActionResult } from "./result";

// Мост «сайт → сборщик дома». Сервера нет: сайт кладёт просьбу в sync_requests, сборщик
// слушает вставки через Realtime, ставит taken_at и пишет обход в sync_runs (миграция v6).
// Глубина обхода — depth (миграции v7 и v18): all (весь список видео), week (7 дней),
// month (30 дней) или range (выбранный период, границы в depth_from/depth_to).
// Что снимать — pick (миграции v12, v13 и v17): тексты комментариев, ветки ответов, надо ли
// брать тексты у не наших видео и с каким охватом листать список (все видео или только наши
// и жёлтые). Сколько видео на креатора — maxVideos (миграция v19): 20/50/100 самых новых в
// пределах глубины; null — без потолка.

// Попросить обход: creatorIds — по строке на каждого креатора, null — одна строка на всех.
// Строк может быть несколько, поэтому возвращаются все id: кнопка следит за ними разом.
// pick и maxVideos идут в каждую строку пачки: выбор в попапе один на всю просьбу.
// range — границы выбранного периода; нужны и пишутся только при depth === 'range'.
export async function requestSync({
  creatorIds,
  depth,
  range,
  pick,
  maxVideos,
}: {
  creatorIds: string[] | null;
  depth: SyncDepth;
  range?: { from: Date; to: Date };
  pick: SyncPick;
  maxVideos: number | null;
}): Promise<ActionResult<{ ids: number[] }>> {
  if (creatorIds !== null && creatorIds.length === 0) return fail("На этой странице нет креаторов");
  // Без границ просьбу отобьёт проверка базы (миграция v18) — говорим это словами человека,
  // а не текстом ошибки Postgres.
  if (depth === "range" && (!range || range.from >= range.to)) return fail(RANGE_REQUIRED);
  const supabase = createClient();

  // requested_by обязателен и должен совпадать с вошедшим — RLS иначе откажет.
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError) return fail(`Не удалось попросить обход: ${authError.message}`);
  if (!auth.user) return fail("Сессия кончилась — войдите заново");

  const requestedBy = auth.user.id;
  // Имена колонок базы, а не полей попапа: all_videos — тот же флаг, что pick.allVideos,
  // videos — охват списка ('all' | 'ours', миграция v17).
  // max_videos — потолок числа видео на креатора (миграция v19); null уходит явно: «без
  // потолка» — такой же осознанный выбор попапа, как и число.
  const flags = {
    comments: pick.comments,
    replies: pick.replies,
    all_videos: pick.allVideos,
    videos: pick.videos,
    max_videos: maxVideos,
  };
  // Границы периода — в каждую строку пачки, как и всё остальное: выбор в попапе один на
  // всю просьбу. У прочих глубин колонки остаются пустыми — этого требует база.
  const bounds =
    depth === "range" && range
      ? { depth_from: range.from.toISOString(), depth_to: range.to.toISOString() }
      : {};
  const rows: SyncRequestInsert[] =
    creatorIds === null
      ? [{ requested_by: requestedBy, creator_id: null, depth, ...bounds, ...flags }]
      : creatorIds.map((creator_id) => ({
          requested_by: requestedBy,
          creator_id,
          depth,
          ...bounds,
          ...flags,
        }));

  const { data, error } = await supabase.from("sync_requests").insert(rows).select("id");
  if (error) return fail(`Не удалось попросить обход: ${error.message}`);
  const ids = (data ?? []).map((r) => r.id);
  // Вставка прошла, а строк не вернулось — следить не за чем, и молчать об этом нельзя.
  if (ids.length === 0) return fail("Просьба не завелась — попробуйте ещё раз");
  return { ok: true, data: { ids } };
}

// Последний обход. Без scope — просто последний (дашборд); со scope (id креатора) —
// последний, который этого креатора касался: его собственный или обход всех.
export async function latestRun(scope?: string): Promise<ActionResult<SyncRun | null>> {
  const base = createClient().from("sync_runs").select("*");
  const filtered = scope ? base.or(`scope.eq.${scope},scope.eq.all`) : base;
  const { data, error } = await filtered
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return fail(`Не удалось прочитать обходы: ${error.message}`);
  return { ok: true, data };
}

// Незакрытые просьбы, которые могла завести эта кнопка: сборщик их ещё не забрал. Нужны,
// чтобы после перезагрузки страницы кнопка снова показала «в очереди». Критерии те же, что
// у requestSync: creatorIds === null — на странице все креаторы, значит любая незакрытая
// просьба (и «за всех», и с явными id — так уходит «Все креаторы» с выбранной площадкой)
// относится к ней; пустая страница — только «за всех»; иначе «за всех» плюс креаторы этой
// страницы (обе кнопки матрицы доступны с одной страницы).
export async function openRequests(creatorIds: string[] | null): Promise<ActionResult<SyncRequest[]>> {
  const base = createClient().from("sync_requests").select("*").is("taken_at", null);
  const filtered =
    creatorIds === null
      ? base
      : creatorIds.length === 0
        ? base.is("creator_id", null)
        : base.or(`creator_id.is.null,creator_id.in.(${creatorIds.join(",")})`);
  const { data, error } = await filtered.order("requested_at", { ascending: false }).limit(200);
  if (error) return fail(`Не удалось прочитать очередь: ${error.message}`);
  return { ok: true, data: data ?? [] };
}

// Свои просьбы по id. Взятые openRequests уже не находит, а кнопке нужно видеть taken_at
// и run_id — иначе между «забрал» и «завёл обход» состояние провалилось бы в покой.
export async function requestsByIds(ids: number[]): Promise<ActionResult<SyncRequest[]>> {
  if (ids.length === 0) return { ok: true, data: [] };
  const { data, error } = await createClient().from("sync_requests").select("*").in("id", ids);
  if (error) return fail(`Не удалось прочитать просьбу: ${error.message}`);
  return { ok: true, data: data ?? [] };
}

// Страница журнала обхода. 500, а не «сколько есть»: PostgREST сам режет ответ на 1000
// строках и делает это молча — на длинном обходе конец журнала просто не приехал бы.
// Поэтому журнал всегда читается страницами по возрастанию id, а следующая берётся по
// `id > after` последней прочитанной.
export const SYNC_LOG_PAGE = 500;

// Строки журнала одного обхода, по возрастанию id. after — id последней уже прочитанной
// строки: 0 (или без него) читает журнал с начала. Таблицу пускает читать только
// администратор (RLS, миграция v16) — у менеджера этот запрос вернул бы пусто, и звать его
// у него незачем: панель хода обновления ему не рендерится вовсе.
export async function syncLog(
  runId: number,
  opts?: { after?: number; limit?: number },
): Promise<ActionResult<SyncLogRow[]>> {
  const after = opts?.after ?? 0;
  const limit = Math.min(opts?.limit ?? SYNC_LOG_PAGE, SYNC_LOG_PAGE);
  const { data, error } = await createClient()
    .from("sync_log")
    .select("*")
    .eq("run_id", runId)
    .gt("id", after)
    .order("id", { ascending: true })
    .limit(limit);
  if (error) return fail(`Не удалось прочитать журнал обхода: ${error.message}`);
  return { ok: true, data: data ?? [] };
}

// Обходы по id — те, что выполняют наши просьбы. Их может быть несколько: сборщик заводит
// свой обход на каждого креатора, но несколько просьб подряд может свести в один.
export async function runsByIds(ids: number[]): Promise<ActionResult<SyncRun[]>> {
  if (ids.length === 0) return { ok: true, data: [] };
  const { data, error } = await createClient().from("sync_runs").select("*").in("id", ids);
  if (error) return fail(`Не удалось прочитать обход: ${error.message}`);
  return { ok: true, data: data ?? [] };
}
