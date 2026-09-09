import { createClient } from "@/lib/supabase/client";
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
  Video,
  VideoComment,
  VideoLatest,
  VideoStats,
} from "./types";
import type { PeriodRange } from "./period";

// Чтение базы для страниц. Сервера нет: всё это запросы из браузера, RLS решает,
// что видно (админу — всё, менеджеру — только его креаторы).

const VIDEO_LIMIT = 2000;
// Пачка id в одном запросе снимков: адрес запроса с id ограничен длиной, а ответ — тысячей строк.
const LATEST_BATCH = 200;
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

// Видео со свежими счётчиками. Связи «видео → video_latest» в схеме нет (это вид без
// внешнего ключа), поэтому берём двумя запросами и сшиваем по id — на наших объёмах
// (сотни видео) это один лишний запрос, а не проблема.
export type VideoRow = Video & {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
};

export async function listVideosWithCounters(creatorId?: string): Promise<VideoRow[]> {
  const supabase = createClient();
  // Страницами по PAGE: `limit(2000)` PostgREST молча урезал бы до 1000 — тот же потолок,
  // что и у снимков ниже.
  const videos: Video[] = [];
  for (let from = 0; from < VIDEO_LIMIT; from += PAGE) {
    let q = supabase
      .from("videos")
      .select("*")
      .order("published_at", { ascending: false, nullsFirst: false })
      .range(from, Math.min(from + PAGE, VIDEO_LIMIT) - 1);
    if (creatorId) q = q.eq("creator_id", creatorId);
    const res = await q;
    fail(res.error);
    const page = res.data ?? [];
    videos.push(...page);
    if (page.length < PAGE) break;
  }

  // Снимки — только для прочитанных видео и пачками: PostgREST молча режет ответ на 1000
  // строках, и когда видео в базе стало 1090, последние 90 на главной остались с нулями
  // (владелец, 2026-09-09: «на новых видео нет ни просмотров, ни лайков»).
  const byId = new Map<string, VideoLatest>();
  const ids = videos.map((v) => v.id);
  for (let i = 0; i < ids.length; i += LATEST_BATCH) {
    const latestRes = await supabase
      .from("video_latest")
      .select("*")
      .in("video_id", ids.slice(i, i + LATEST_BATCH));
    fail(latestRes.error);
    for (const l of latestRes.data ?? []) byId.set(l.video_id, l);
  }
  return videos.map((v) => {
    const l = byId.get(v.id);
    return {
      ...v,
      views: l?.views ?? 0,
      likes: l?.likes ?? 0,
      comments: l?.comments ?? 0,
      shares: l?.shares ?? 0,
      saves: l?.saves ?? 0,
    };
  });
}

export async function videoStatsBetween(creatorId: string, range: PeriodRange): Promise<VideoStats[]> {
  const { data, error } = await createClient().rpc("video_stats_between", {
    p_creator: creatorId,
    p_from: range.from.toISOString(),
    p_to: range.to.toISOString(),
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

export async function creatorsOverview(range: PeriodRange): Promise<CreatorOverview[]> {
  const { data, error } = await createClient().rpc("creators_overview", {
    p_from: range.from.toISOString(),
    p_to: range.to.toISOString(),
  });
  fail(error);
  return data ?? [];
}

// График по дням считает база, поэтому фильтр площадки уходит в неё параметром
// (миграция v10): null — все площадки, как было до переключателя.
export async function dailyViewsAll(
  range: PeriodRange,
  platform: Platform | null = null,
): Promise<DailyViews[]> {
  const { data, error } = await createClient().rpc("daily_views_all", {
    p_from: range.from.toISOString(),
    p_to: range.to.toISOString(),
    p_platform: platform,
  });
  fail(error);
  return data ?? [];
}

export async function creatorDailyViews(creatorId: string, range: PeriodRange): Promise<DailyViews[]> {
  const { data, error } = await createClient().rpc("creator_daily_views", {
    p_creator: creatorId,
    p_from: range.from.toISOString(),
    p_to: range.to.toISOString(),
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
  t.engagement = t.likes + t.comments + t.shares;
  return t;
}
