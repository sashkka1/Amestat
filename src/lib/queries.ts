import { createClient } from "@/lib/supabase/client";
import { engagementOf } from "./stats";
import type {
  Creator,
  CreatorArchive,
  CreatorLatest,
  CreatorManager,
  CreatorOverview,
  CreatorTag,
  DailyViews,
  Platform,
  Tag,
  VideoComment,
  VideoStats,
  VideoWithLatest,
} from "./types";
import type { PeriodRange } from "./period";
import type { Scope } from "./dashboard-prefs";

// Охват «Только наши» считает база (миграция v22): у всех четырёх статистических функций
// есть `p_only_ours`, и «наше» там значит ровно то же, что у клиентского `matchesScope` —
// `videos.ours or videos.watch`.

// Чтение базы для страниц. Сервера нет: всё это запросы из браузера, RLS решает,
// что видно (админу — всё, менеджеру — только его креаторы).

const VIDEO_LIMIT = 2000;
// Страница списка видео: ровно потолок PostgREST.
const PAGE = 1000;

function fail(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

export async function listCreators(): Promise<Creator[]> {
  const { data, error } = await createClient()
    .from("creators")
    .select("*")
    .order("sort_order", { ascending: true })
    .order("added_at", { ascending: true });
  fail(error);
  return data ?? [];
}

export async function creatorById(id: string): Promise<Creator | null> {
  const { data, error } = await createClient().from("creators").select("*").eq("id", id).maybeSingle();
  fail(error);
  return data;
}

export async function listCreatorLatest(): Promise<CreatorLatest[]> {
  const { data, error } = await createClient().from("creator_latest").select("*");
  fail(error);
  return data ?? [];
}

export async function listTags(): Promise<Tag[]> {
  const { data, error } = await createClient().from("tags").select("*").order("name");
  fail(error);
  return data ?? [];
}

export async function listCreatorTags(): Promise<CreatorTag[]> {
  const { data, error } = await createClient().from("creator_tags").select("*");
  fail(error);
  return data ?? [];
}

export async function listCreatorManagers(): Promise<CreatorManager[]> {
  const { data, error } = await createClient().from("creator_managers").select("*");
  fail(error);
  return data ?? [];
}

export async function listArchive(): Promise<CreatorArchive[]> {
  const { data, error } = await createClient()
    .from("creators_archive")
    .select("*")
    .order("deleted_at", { ascending: false });
  fail(error);
  return data ?? [];
}

// Видео за срок вместе со свежим снимком — ОДИН вызов `videos_with_latest` (миграция v23).
//
// Было до v23: список видео страницами по 1000, а затем счётчики — пачками по 200 id из вида
// `video_latest`. На 1234 видео это девять запросов подряд, и каждый упирался в RLS, которая
// звала `can_see_creator()` на каждую строку: одни только снимки отнимали ~6 с. Теперь срок,
// площадка и охват уходят в базу, а связь «видео → последний снимок» делает lateral внутри.
//
// ⚠️ Видео без даты публикации не приходят вовсе: у страницы есть срок, а положить их некуда.
//
// ⚠️ Потолок PostgREST в 1000 строк действует и на ответ функции, поэтому за сроком «Всё
// время» (1234 видео) идём страницами через Range. Молча урезанный ответ здесь — это ровно
// та беда, что владелец видел 2026-09-09: «на новых видео нет ни просмотров, ни лайков».
// Порядок внутри функции доопределён по id, иначе на стыке страниц строки задваивались бы.
export type VideoRow = VideoWithLatest;

export async function listVideosWithLatest(
  range: PeriodRange,
  {
    creatorId = null,
    platform = null,
    scope = "all",
  }: { creatorId?: string | null; platform?: Platform | null; scope?: Scope } = {},
): Promise<VideoRow[]> {
  const supabase = createClient();
  const rows: VideoRow[] = [];
  for (let from = 0; from < VIDEO_LIMIT; from += PAGE) {
    const { data, error } = await supabase
      .rpc("videos_with_latest", {
        p_from: range.from.toISOString(),
        p_to: range.to.toISOString(),
        p_creator: creatorId,
        p_platform: platform,
        p_only_ours: scope === "ours",
        p_limit: VIDEO_LIMIT,
      })
      .range(from, Math.min(from + PAGE, VIDEO_LIMIT) - 1);
    fail(error);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

export async function videoStatsBetween(
  creatorId: string,
  range: PeriodRange,
  scope: Scope = "all",
): Promise<VideoStats[]> {
  const { data, error } = await createClient().rpc("video_stats_between", {
    p_creator: creatorId,
    p_from: range.from.toISOString(),
    p_to: range.to.toISOString(),
    p_only_ours: scope === "ours",
  });
  fail(error);
  return data ?? [];
}

// Жёлтые видео креатора — те, у которых `watch = true` (миграция v17). Отдельным запросом,
// как comments_synced_at: функция video_stats_between про эту колонку не знает, а карточке
// креатора состояние видео нужно целиком. Читаются только id жёлтых — их единицы.
export async function listVideoWatch(creatorId: string): Promise<Set<string>> {
  const { data, error } = await createClient()
    .from("videos")
    .select("id")
    .eq("creator_id", creatorId)
    .eq("watch", true)
    // Тот же потолок, что у PostgREST: молча урезанный ответ здесь означал бы видео,
    // которое в таблице внезапно перестало быть жёлтым.
    .limit(PAGE);
  fail(error);
  return new Set((data ?? []).map((v) => v.id));
}

// Подписчики на концах срока. Снимка до начала может не быть (история началась позже) —
// тогда началом считается первый снимок внутри срока, как в функциях по видео.
export async function creatorFollowers(
  creatorId: string,
  range: PeriodRange,
): Promise<{ now: number | null; before: number | null }> {
  const supabase = createClient();
  const from = range.from.toISOString();
  const to = range.to.toISOString();
  const base = () => supabase.from("creator_snaps").select("followers, taken_at").eq("creator_id", creatorId);
  const [nowRes, beforeRes, firstInsideRes] = await Promise.all([
    base().lte("taken_at", to).order("taken_at", { ascending: false }).limit(1).maybeSingle(),
    base().lte("taken_at", from).order("taken_at", { ascending: false }).limit(1).maybeSingle(),
    base()
      .gt("taken_at", from)
      .lte("taken_at", to)
      .order("taken_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);
  fail(nowRes.error);
  fail(beforeRes.error);
  fail(firstInsideRes.error);
  return {
    now: nowRes.data?.followers ?? null,
    before: beforeRes.data?.followers ?? firstInsideRes.data?.followers ?? null,
  };
}

export async function videoHistory(videoId: string): Promise<{ t: string; views: number }[]> {
  const { data, error } = await createClient()
    .from("video_snaps")
    .select("taken_at, views")
    .eq("video_id", videoId)
    .order("taken_at", { ascending: true });
  fail(error);
  return (data ?? []).map((s) => ({ t: s.taken_at, views: s.views ?? 0 }));
}

// Комментарии одного видео (миграция v11). Их бывают сотни, поэтому страницами:
// count — сколько всего в базе, по нему панель решает, показывать ли «Показать ещё».
export type CommentSort = "likes" | "newest";

// Только корневые: ответы лежат в той же таблице с parent_id родителя и приходят
// отдельным запросом, когда ветку разворачивают. Иначе страница по 30 строк
// набивалась бы ответами, а корневые уезжали бы вниз.
export async function listVideoComments(
  videoId: string,
  { sort, limit, offset = 0 }: { sort: CommentSort; limit: number; offset?: number },
): Promise<{ rows: VideoComment[]; count: number }> {
  let query = createClient()
    .from("video_comments")
    .select("*", { count: "exact" })
    .eq("video_id", videoId)
    .is("parent_id", null);
  query =
    sort === "likes"
      ? query.order("likes", { ascending: false, nullsFirst: false })
      : query.order("created_at", { ascending: false, nullsFirst: false });
  // Второй ключ — чтобы страницы не перемешивались: у комментариев с одинаковыми
  // лайками (или без даты) порядок иначе от запроса к запросу свой.
  const { data, error, count } = await query
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  fail(error);
  return { rows: data ?? [], count: count ?? 0 };
}

// Ответы на один корневой комментарий, старые сверху — как их показывает площадка.
// Без страниц: сборщик снимает не больше 20 ответов на корневой.
export async function listCommentReplies(videoId: string, parentId: string): Promise<VideoComment[]> {
  const { data, error } = await createClient()
    .from("video_comments")
    .select("*")
    .eq("video_id", videoId)
    .eq("parent_id", parentId)
    .order("created_at", { ascending: true, nullsFirst: false })
    // Второй ключ — на случай ответов без даты: иначе их порядок от запроса к запросу свой.
    .order("id", { ascending: true });
  fail(error);
  return data ?? [];
}

// Когда у этого видео последний раз снимали тексты комментариев. Отдельным запросом:
// video_stats_between про колонку videos.comments_synced_at не знает.
export async function videoCommentsSyncedAt(videoId: string): Promise<string | null> {
  const { data, error } = await createClient()
    .from("videos")
    .select("comments_synced_at")
    .eq("id", videoId)
    .maybeSingle();
  fail(error);
  return data?.comments_synced_at ?? null;
}

export async function creatorsOverview(
  range: PeriodRange,
  scope: Scope = "all",
): Promise<CreatorOverview[]> {
  const { data, error } = await createClient().rpc("creators_overview", {
    p_from: range.from.toISOString(),
    p_to: range.to.toISOString(),
    p_only_ours: scope === "ours",
  });
  fail(error);
  return data ?? [];
}

// График по дням считает база, поэтому фильтр площадки уходит в неё параметром
// (миграция v10): null — все площадки, как было до переключателя.
//
// ⚠️ Значение дня — не «сколько сборщик увидел в этот день», а «сколько набрали видео,
// вышедшие в этот день» (миграция v21): текущие счётчики этих роликов. День снимка на числа
// не влияет вовсе.
export async function dailyViewsAll(
  range: PeriodRange,
  platform: Platform | null = null,
  scope: Scope = "all",
): Promise<DailyViews[]> {
  const { data, error } = await createClient().rpc("daily_views_all", {
    p_from: range.from.toISOString(),
    p_to: range.to.toISOString(),
    p_platform: platform,
    p_only_ours: scope === "ours",
  });
  fail(error);
  return data ?? [];
}

// Ряд карточки креатора — та же атрибуция по дате публикации, что и у ряда по всем
// (миграция v21).
export async function creatorDailyViews(
  creatorId: string,
  range: PeriodRange,
  scope: Scope = "all",
): Promise<DailyViews[]> {
  const { data, error } = await createClient().rpc("creator_daily_views", {
    p_creator: creatorId,
    p_from: range.from.toISOString(),
    p_to: range.to.toISOString(),
    p_only_ours: scope === "ours",
  });
  fail(error);
  return data ?? [];
}

// Сводка по всем видимым креаторам за срок — сумма рядов creators_overview.
export type Totals = {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  engagement: number;
  videos: number;
  followers: number;
  followersDelta: number;
};

export function sumOverview(rows: CreatorOverview[]): Totals {
  const t: Totals = {
    views: 0, likes: 0, comments: 0, shares: 0, saves: 0,
    engagement: 0, videos: 0, followers: 0, followersDelta: 0,
  };
  for (const r of rows) {
    t.views += r.views_delta;
    t.likes += r.likes_delta;
    t.comments += r.comments_delta;
    t.shares += r.shares_delta;
    t.saves += r.saves_delta;
    t.videos += r.videos_published;
    t.followers += r.followers_now ?? 0;
    t.followersDelta += r.followers_delta ?? 0;
  }
  // Формула вовлечённости — одна на весь сайт (`lib/stats.ts`).
  t.engagement = engagementOf(t);
  return t;
}
