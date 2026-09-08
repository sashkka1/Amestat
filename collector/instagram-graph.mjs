// Instagram через официальный Graph API, приём Business Discovery: наш бизнес-аккаунт
// (IG_USER_ID) спрашивает публичные данные чужого профессионального аккаунта по его @имени.
//
// Ограничения приёма, о которых надо помнить:
//   • видит только Business/Creator-аккаунты; личный отдаёт ошибку;
//   • лайков всего у профиля не бывает вовсе — likes_total остаётся null;
//   • `view_count` есть не на всех версиях API: если поле не знают, повторяем без него,
//     и просмотры тогда null (остальное приезжает как обычно).
//
// ⚠️ Токен в тексты ошибок не попадает: он лежит в адресе, поэтому наружу отдаём только путь.

const API = "https://graph.facebook.com/v21.0";
const PAGE = 50;         // публикаций за один запрос
const MAX_MEDIA = 200;   // потолок: дальше в прошлое не ходим
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const num = (x) => (x === null || x === undefined || x === "" ? null : Number(x));

function mediaPart(withViews, after) {
  const fields = [
    "id", "media_type", "media_product_type", "caption", "permalink",
    "thumbnail_url", "media_url", "timestamp", "like_count", "comments_count",
    ...(withViews ? ["view_count"] : []),
  ].join(",");
  const args = [`limit(${PAGE})`, ...(after ? [`after(${after})`] : [])].join(".");
  return `media.${args}{${fields}}`;
}

async function ask(handle, { token, userId, withViews, after }) {
  const fields = `business_discovery.username(${handle}){username,name,biography,profile_picture_url,followers_count,follows_count,media_count,${mediaPart(withViews, after)}}`;
  const url = `${API}/${encodeURIComponent(userId)}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Instagram: ответ Graph API не разобран (HTTP ${res.status})`);
  }
  if (json?.error) {
    const e = json.error;
    return { error: { message: e.message ?? "без текста", code: e.code ?? null, sub: e.error_subcode ?? null } };
  }
  if (!res.ok) throw new Error(`Instagram: Graph API ответил HTTP ${res.status}`);
  const bd = json?.business_discovery;
  if (!bd) throw new Error(`Instagram: профиль не найден или не бизнес-аккаунт: @${handle}`);
  return { bd };
}

const looksLikeUnknownViewCount = (err) => /view_count/i.test(err.message ?? "");

/**
 * Сбор креатора Instagram через Graph API.
 * `depth` — 'all' (до потолка MAX_MEDIA) или 'week' (только последние 7 дней).
 * Отдаёт ту же форму, что и TikTok: `{ profile, videos }`.
 */
export async function collectInstagramGraph(creator, { token = "", userId = "", depth = "all", log } = {}) {
  if (!token) throw new Error("Instagram: нет IG_ACCESS_TOKEN — впиши токен в .env.local или переключи IG_SOURCE на web");
  if (!userId) throw new Error("Instagram: нет IG_USER_ID — нужен id нашего бизнес-аккаунта в .env.local");
  const handle = String(creator.handle || "").replace(/^@/, "");
  if (!handle) throw new Error("у креатора пустой handle");
  // Публикации приходят от новых к старым, поэтому «неделя» — ранний выход из пагинации:
  // страница кончилась публикацией старше границы — следующую не просим.
  const since = depth === "week" ? Date.now() - WEEK_MS : null;

  let withViews = true;
  let after = null;
  let head = null;
  const items = [];

  for (let round = 0; round < Math.ceil(MAX_MEDIA / PAGE) + 1; round++) {
    const res = await ask(handle, { token, userId, withViews, after });
    if (res.error) {
      if (withViews && looksLikeUnknownViewCount(res.error)) {
        // Эта версия API поля не знает — повторяем без него, просмотры останутся пустыми.
        log?.("  Graph API не знает view_count — повтор без просмотров");
        withViews = false;
        round--;
        continue;
      }
      throw new Error(`Instagram: Graph API отказал (${res.error.code ?? "?"}): ${res.error.message}`);
    }
    head = head ?? res.bd;
    const media = res.bd.media ?? {};
    const data = media.data ?? [];
    for (const item of data) items.push(item);
    after = media.paging?.cursors?.after ?? null;
    if (!after || data.length === 0 || items.length >= MAX_MEDIA) break;
    const oldest = data.at(-1)?.timestamp ? Date.parse(data.at(-1).timestamp) : null;
    if (since !== null && oldest !== null && !Number.isNaN(oldest) && oldest < since) break;
  }

  const profile = {
    followers: num(head.followers_count),
    following: num(head.follows_count),
    likesTotal: null,                       // Graph API суммы лайков профиля не отдаёт вовсе
    videosCount: num(head.media_count),
    nickname: head.name || head.username || handle,
    signature: head.biography || "",
    avatar: head.profile_picture_url || null,
  };

  const taken = items.slice(0, MAX_MEDIA);
  // Последняя страница приезжает целиком, и в ней есть соседи старше границы — отсекаем их.
  const fresh = since === null
    ? taken
    : taken.filter((m) => m.timestamp && !Number.isNaN(Date.parse(m.timestamp)) && Date.parse(m.timestamp) >= since);

  const videos = fresh.map((m) => ({
    id: String(m.id),
    publishedAt: m.timestamp ? new Date(m.timestamp).toISOString() : null,
    caption: m.caption || "",
    coverUrl: m.thumbnail_url ?? m.media_url ?? null,
    // `videos.url` в базе NOT NULL: без permalink (бывает у архивных) ставим профиль.
    url: m.permalink ?? `https://www.instagram.com/${handle}/`,
    durationS: null,                        // длительности в Business Discovery нет
    views: withViews ? num(m.view_count) : null,
    likes: num(m.like_count),
    comments: num(m.comments_count),
    shares: null,                           // репостов и сохранений чужого аккаунта API не даёт
    saves: null,
  }));

  log?.(`  Instagram Graph: подписчиков ${profile.followers}, публикаций по профилю ${profile.videosCount}, собрано ${taken.length}${withViews ? "" : " (без просмотров)"}`);
  if (since !== null) log?.(`  за неделю: ${videos.length} из ${taken.length} пришедших`);
  return { profile, videos };
}
