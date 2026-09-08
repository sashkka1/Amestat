import { createClient } from "@/lib/supabase/client";
import type { SyncDepth, SyncRequest, SyncRequestInsert, SyncRun } from "@/lib/types";
import { fail, type ActionResult } from "./result";

// Мост «сайт → сборщик дома». Сервера нет: сайт кладёт просьбу в sync_requests, сборщик
// слушает вставки через Realtime, ставит taken_at и пишет обход в sync_runs (миграция v6).
// Глубина обхода — depth: all (весь список видео) или week (только за 7 дней), миграция v7.
// Что снимать — comments и replies (миграция v12): тексты комментариев и ветки ответов.

// Попросить обход: creatorIds — по строке на каждого креатора, null — одна строка на всех.
// Строк может быть несколько, поэтому возвращаются все id: кнопка следит за ними разом.
// comments/replies идут в каждую строку пачки: выбор в попапе один на всю просьбу.
export async function requestSync({
  creatorIds,
  depth,
  comments,
  replies,
}: {
  creatorIds: string[] | null;
  depth: SyncDepth;
  comments: boolean;
  replies: boolean;
}): Promise<ActionResult<{ ids: number[] }>> {
  if (creatorIds !== null && creatorIds.length === 0) return fail("На этой странице нет креаторов");
  const supabase = createClient();

  // requested_by обязателен и должен совпадать с вошедшим — RLS иначе откажет.
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError) return fail(`Не удалось попросить обход: ${authError.message}`);
  if (!auth.user) return fail("Сессия кончилась — войдите заново");

  const requestedBy = auth.user.id;
  const rows: SyncRequestInsert[] =
    creatorIds === null
      ? [{ requested_by: requestedBy, creator_id: null, depth, comments, replies }]
      : creatorIds.map((creator_id) => ({
          requested_by: requestedBy,
          creator_id,
          depth,
          comments,
          replies,
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

// Обходы по id — те, что выполняют наши просьбы. Их может быть несколько: сборщик заводит
// свой обход на каждого креатора, но несколько просьб подряд может свести в один.
export async function runsByIds(ids: number[]): Promise<ActionResult<SyncRun[]>> {
  if (ids.length === 0) return { ok: true, data: [] };
  const { data, error } = await createClient().from("sync_runs").select("*").in("id", ids);
  if (error) return fail(`Не удалось прочитать обход: ${error.message}`);
  return { ok: true, data: data ?? [] };
}
