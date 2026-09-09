// Типы строк — вручную, по supabase/migrations/ (init → videos_ours → v2_roles_api).
// Меняется схема — меняется этот файл в тот же заход.

export type Platform = "tiktok" | "instagram";
// retry — повтор через час после неудачного обхода по расписанию, заводит сборщик (миграция v7).
export type SyncTrigger = "schedule" | "catchup" | "manual" | "retry";
// Глубина обхода (миграции v7 и v18): all — весь список видео, week — за последние 7 дней,
// month — за последние 30 дней, range — за выбранный период (depth_from … depth_to).
// ⚠️ У 'range' обе границы обязательны и depth_from < depth_to — это проверка в базе;
// у остальных глубин они пусты. Кто пишет просьбу, тот и держит это правило.
export type SyncDepth = "all" | "week" | "month" | "range";
// Охват видео в обходе (миграция v17): all — весь список, как в ежедневном обходе;
// ours — список листается лишь до наших и жёлтых видео, остальные не смотрим и экономим
// время. Расписание всегда ходит с 'all'.
export type SyncVideos = "all" | "ours";
// Что снимать в этом обходе — флаги просьбы (миграции v12, v13 и v17). Ходят вместе: их
// выбирают одними и теми же блоками попапа, и порознь ни одно место их не собирает.
// - comments — тексты комментариев; replies — ветки ответов под ними (без comments не бывает);
// - allVideos — снимать тексты и у не наших видео (обычно только у `videos.ours = true`);
// - videos — охват списка видео: все или только наши и жёлтые.
export type SyncPick = {
  comments: boolean;
  replies: boolean;
  allVideos: boolean;
  videos: SyncVideos;
};
export type Role = "admin" | "manager";

export type Profile = {
  user_id: string;
  role: Role;
  login: string;
  display_name: string;
  invited_by: string | null;
  created_at: string;
};

export type ProfileUpdate = { display_name?: string };

export type Invite = {
  id: string;
  token: string;
  note: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by: string | null;
};

// Админ вставляет только заметку и себя: токен и срок ставит база (миграция v3).
export type InviteInsert = { note?: string; created_by: string };

// Что RPC check_invite думает о ссылке (миграция v5).
export type InviteCheck = "ok" | "used" | "expired" | "invalid";

export type Creator = {
  id: string;
  platform: Platform;
  handle: string;
  display_name: string;
  description: string;
  profile_url: string;
  avatar_url: string | null;
  avatar_custom: boolean;
  sort_order: number;
  added_at: string;
  last_synced_at: string | null;
  sync_error: string | null;
  // Галочка «все видео наши»: у новых видео этого креатора снимаются подробности (v15).
  all_videos_ours: boolean;
  // Кто выпустил ссылку подключения; null — заведён руками.
  connected_by: string | null;
  // open_id TikTok: есть — креатор подключён через официальный API.
  tiktok_open_id: string | null;
  // Ключ протух — обход не идёт, пока креатор не пройдёт по ссылке заново.
  needs_reconnect: boolean;
};

export type CreatorInsert = {
  id?: string;
  platform?: Platform;
  handle: string;
  display_name?: string;
  description?: string;
  profile_url: string;
  avatar_url?: string | null;
  avatar_custom?: boolean;
  sort_order?: number;
  added_at?: string;
  last_synced_at?: string | null;
  sync_error?: string | null;
  all_videos_ours?: boolean;
  connected_by?: string | null;
  tiktok_open_id?: string | null;
  needs_reconnect?: boolean;
};

export type CreatorUpdate = Partial<CreatorInsert>;

export type CreatorManager = {
  creator_id: string;
  manager_id: string;
  assigned_by: string | null;
  assigned_at: string;
};

export type CreatorManagerInsert = {
  creator_id: string;
  manager_id: string;
  assigned_by?: string | null;
  assigned_at?: string;
};

export type CreatorArchive = {
  id: string;
  platform: Platform;
  handle: string;
  display_name: string;
  description: string;
  avatar_url: string | null;
  profile_url: string;
  added_at: string;
  managers: string[];
  deleted_at: string;
  deleted_by: string | null;
  deleted_by_login: string;
};

export type Tag = {
  id: string;
  name: string;
  color: string;
  created_at: string;
  owner_id: string;
};

export type TagInsert = { id?: string; name: string; color?: string; created_at?: string; owner_id: string };
export type TagUpdate = Partial<TagInsert>;

export type CreatorTag = { creator_id: string; tag_id: string };

export type CreatorSnap = {
  id: number;
  creator_id: string;
  taken_at: string;
  followers: number | null;
  following: number | null;
  likes_total: number | null;
  videos_count: number | null;
};

export type Video = {
  id: string;
  creator_id: string;
  published_at: string | null;
  caption: string;
  cover_url: string | null;
  url: string;
  duration_s: number | null;
  first_seen_at: string;
  last_seen_at: string;
  // «Наше» — снимать подробности (тексты комментариев, ветки), а не «считать в статистике»
  // (миграция v15): общие счётчики идут по всем видео. Ставит триггер, меняет пользователь.
  ours: boolean;
  // «Жёлтое» (миграция v17): не наше, но историю счётчиков собираем. Смысл имеет только при
  // ours = false; пара читается и пишется вместе — `lib/video-state.ts`.
  watch: boolean;
  // Когда сборщик последний раз снимал тексты комментариев (миграция v11); null — ещё не снимал.
  comments_synced_at: string | null;
};

export type VideoUpdate = { ours?: boolean; watch?: boolean };

// Тексты комментариев площадки (миграция v11). Пишет только сборщик; сайт читает то,
// что пускает can_see_creator через видео. Ключ — пара (video_id, id).
export type VideoComment = {
  id: string;
  video_id: string;
  // Ответ на комментарий: id родителя; у корневых null.
  parent_id: string | null;
  author_handle: string;
  author_name: string;
  text: string;
  likes: number | null;
  // Число ответов у корневого комментария.
  replies: number | null;
  // Когда написан на площадке; площадка может его не отдать.
  created_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
};

export type VideoSnap = {
  id: number;
  video_id: string;
  taken_at: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
};

export type SyncRun = {
  id: number;
  started_at: string;
  finished_at: string | null;
  trigger: SyncTrigger;
  ok: boolean | null;
  error: string | null;
  creators_done: number;
  creators_failed: number;
  log: string;
  requested_by: string | null;
  // 'all' — обход всех видимых; иначе id одного креатора.
  scope: string;
  depth: SyncDepth;
  // Границы периода у depth = 'range' (миграция v18); у остальных глубин null.
  depth_from: string | null;
  depth_to: string | null;
  // Чем шёл обход (миграция v12): снимались ли тексты комментариев и ветки ответов.
  comments: boolean;
  replies: boolean;
  // Тексты снимались и у не наших видео (миграция v13). Расписание его не ставит никогда.
  all_videos: boolean;
  // С каким охватом видео шёл обход (миграция v17). Расписание всегда 'all'.
  videos: SyncVideos;
  // Потолок числа видео на креатора (миграция v19): не больше стольких самых новых видео
  // в пределах глубины. null — без потолка; расписание ходит без него.
  max_videos: number | null;
  // Ход обхода, видимый с сайта (миграция v14). creators_done и creators_failed сборщик
  // теперь двигает после каждого креатора, а не пишет один раз в конце.
  // creators_total — сколько всего в этом обходе; null — список ещё не отобран.
  creators_total: number | null;
  // Кого собираем прямо сейчас — по одному на полосу (TikTok/Instagram), уже с «@».
  // Колонка not null default '{}': пустой массив, а не null.
  current_handles: string[];
  // Когда последний раз двигались счётчики.
  progress_at: string | null;
  // Каким путём шёл обход в целом (миграция v16): 'providers' | 'browser' | 'mixed'.
  source: string | null;
  // Итог по аккаунтам провайдеров за обход (миграция v16). Сайт его пока не показывает,
  // поэтому форма не разбирается: строка обхода читается через select('*') целиком.
  accounts: unknown[];
};

// Уровень строки журнала обхода: обычная, предупреждение, ошибка.
export type SyncLogLevel = "info" | "warn" | "error";

// Строка живого журнала обхода (миграция v16). Пишет только сборщик, читает по RLS только
// администратор — менеджеру таблица не видна вовсе, и сайт её у него не спрашивает.
export type SyncLogRow = {
  id: number;
  // Обход, к которому строка относится; null — обход уже удалён (on delete cascade их уносит).
  run_id: number | null;
  at: string;
  level: SyncLogLevel;
  // Откуда пришли данные строки: ensembledata | apify | browser | system.
  source: string;
  // Метка аккаунта провайдера: «ED#1», «Apify#2»; null — строка не про аккаунт.
  account: string | null;
  creator_handle: string | null;
  text: string;
  // Сколько стоила операция и сколько осталось у аккаунта после неё — в его единицах.
  units_spent: number | null;
  units_left: number | null;
  // Единица счёта аккаунта: 'units' (EnsembleData, в день) или 'usd' (Apify, в месяц).
  units_kind: string | null;
};

// Просьба «обновить» с сайта (миграция v6). Сайт вставляет, сборщик дома забирает:
// taken_at — забрал, run_id — обход, который её выполнил.
export type SyncRequest = {
  id: number;
  requested_at: string;
  requested_by: string;
  // null — обойти всех видимых креаторов.
  creator_id: string | null;
  // Резидент дома принял просьбу в очередь: компьютер и сборщик живы (миграция v8).
  seen_at: string | null;
  taken_at: string | null;
  run_id: number | null;
  depth: SyncDepth;
  // Границы выбранного периода (миграция v18): заполнены только при depth = 'range',
  // обе сразу и depth_from < depth_to — иначе вставку отобьёт проверка базы.
  depth_from: string | null;
  depth_to: string | null;
  // Что снимать (миграция v12): тексты комментариев и ветки ответов под ними.
  // replies без comments смысла не имеет — галочка в матрице гаснет вместе с первой.
  comments: boolean;
  replies: boolean;
  // Снимать тексты и у не наших видео (миграция v13): обычно они берутся только у
  // `videos.ours = true`, а счётчики — у всех. Тоже гаснет без comments.
  all_videos: boolean;
  // Охват списка видео (миграция v17): 'all' — весь список; 'ours' — только наши и жёлтые.
  videos: SyncVideos;
  // Потолок числа видео на креатора (миграция v19): не больше стольких самых новых видео
  // в пределах глубины. null — без потолка. Нужен там, где у креатора вся история длинная,
  // а «неделя» пуста: 20/50/100 самых новых поверх глубины по времени.
  max_videos: number | null;
  // База сама (pg_cron) написала владельцу в Telegram: просьбу никто не принял за 3 минуты.
  notified_at: string | null;
};

// Остальное ставит база: requested_at, depth, comments, replies, all_videos, videos и
// max_videos — по умолчанию, taken_at и run_id — сборщик.
export type SyncRequestInsert = {
  requested_by: string;
  creator_id?: string | null;
  depth?: SyncDepth;
  // Только при depth = 'range' и только парой (миграция v18).
  depth_from?: string | null;
  depth_to?: string | null;
  comments?: boolean;
  replies?: boolean;
  all_videos?: boolean;
  videos?: SyncVideos;
  // Потолок видео на креатора (миграция v19); null — без потолка, как и по умолчанию.
  max_videos?: number | null;
};

export type CreatorLatest = {
  creator_id: string;
  taken_at: string;
  followers: number | null;
  following: number | null;
  likes_total: number | null;
  videos_count: number | null;
};

export type VideoLatest = {
  video_id: string;
  taken_at: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
};

// Результат RPC videos_with_latest (миграция v23): строка videos плюс счётчики последнего
// снимка. `taken_at` — когда он снят; null, если снимков у видео ещё нет.
export type VideoWithLatest = Video & {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  taken_at: string | null;
};

// Результат RPC video_stats_between.
export type VideoStats = {
  video_id: string;
  published_at: string | null;
  caption: string;
  cover_url: string | null;
  url: string;
  // «Наше»: у таких видео снимаются подробности. ⚠️ Колонки `videos.watch` (жёлтое,
  // миграция v17) функция не отдаёт — жёлтые id страница дочитывает `listVideoWatch`.
  ours: boolean;
  views_now: number | null;
  likes_now: number | null;
  comments_now: number | null;
  shares_now: number | null;
  saves_now: number | null;
  views_delta: number;
  likes_delta: number;
  comments_delta: number;
  shares_delta: number;
  saves_delta: number;
};

// Результат RPC creator_daily_views и daily_views_all (миграции v4 и v21): пять счётчиков
// по дням. ⚠️ Значение дня — сумма ТЕКУЩИХ счётчиков видео, опубликованных в этот день, а не
// накопленная сумма и не прирост по снимкам: сайт рисует значения как есть, а «накопительно»
// складывает их бегущей суммой (`runningTotal` в lib/stats.ts).
export type DailyViews = {
  day: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
};

// Результат RPC creators_overview: по одному ряду на видимого креатора за срок.
export type CreatorOverview = {
  creator_id: string;
  followers_now: number | null;
  followers_delta: number | null;
  videos_total: number;
  videos_published: number;
  views_delta: number;
  likes_delta: number;
  comments_delta: number;
  shares_delta: number;
  saves_delta: number;
  median_views_delta: number | null;
};

type Relationships = [];

// Схема в форме, которую понимает supabase-js: типизированные запросы и RPC.
export type Database = {
  public: {
    Tables: {
      profiles: { Row: Profile; Insert: never; Update: ProfileUpdate; Relationships: Relationships };
      invites: { Row: Invite; Insert: InviteInsert; Update: never; Relationships: Relationships };
      creators: { Row: Creator; Insert: CreatorInsert; Update: CreatorUpdate; Relationships: Relationships };
      creator_managers: {
        Row: CreatorManager;
        Insert: CreatorManagerInsert;
        Update: never;
        Relationships: Relationships;
      };
      creators_archive: { Row: CreatorArchive; Insert: never; Update: never; Relationships: Relationships };
      tags: { Row: Tag; Insert: TagInsert; Update: TagUpdate; Relationships: Relationships };
      creator_tags: { Row: CreatorTag; Insert: CreatorTag; Update: Partial<CreatorTag>; Relationships: Relationships };
      creator_snaps: { Row: CreatorSnap; Insert: never; Update: never; Relationships: Relationships };
      videos: { Row: Video; Insert: never; Update: VideoUpdate; Relationships: Relationships };
      video_snaps: { Row: VideoSnap; Insert: never; Update: never; Relationships: Relationships };
      video_comments: { Row: VideoComment; Insert: never; Update: never; Relationships: Relationships };
      sync_runs: { Row: SyncRun; Insert: never; Update: never; Relationships: Relationships };
      sync_log: { Row: SyncLogRow; Insert: never; Update: never; Relationships: Relationships };
      sync_requests: {
        Row: SyncRequest;
        Insert: SyncRequestInsert;
        Update: never;
        Relationships: Relationships;
      };
    };
    Views: {
      creator_latest: { Row: CreatorLatest; Relationships: Relationships };
      video_latest: { Row: VideoLatest; Relationships: Relationships };
    };
    Functions: {
      // ⚠️ `p_only_ours` есть у всех четырёх функций с миграции v22: охват «Только наши»
      // считает база, а не клиент.
      video_stats_between: {
        Args: { p_creator: string; p_from: string; p_to: string; p_only_ours?: boolean };
        Returns: VideoStats[];
      };
      creator_daily_views: {
        Args: { p_creator: string; p_from: string; p_to: string; p_only_ours?: boolean };
        Returns: DailyViews[];
      };
      creators_overview: {
        Args: { p_from: string; p_to: string; p_only_ours?: boolean };
        Returns: CreatorOverview[];
      };
      // p_platform необязателен (миграция v10): null — все площадки.
      daily_views_all: {
        Args: { p_from: string; p_to: string; p_platform?: string | null; p_only_ours?: boolean };
        Returns: DailyViews[];
      };
      // Видео за срок вместе с последним снимком (миграция v23) — вместо пары
      // «страницы videos» + «пачки video_latest».
      videos_with_latest: {
        Args: {
          p_from: string;
          p_to: string;
          p_creator?: string | null;
          p_platform?: string | null;
          p_only_ours?: boolean;
          p_limit?: number;
        };
        Returns: VideoWithLatest[];
      };
      // Пароль менеджеру ставит админ, старого не видя (миграция v3).
      admin_set_password: {
        Args: { p_user: string; p_password: string };
        Returns: undefined;
      };
      // Проверки до регистрации (миграция v5): зовутся без входа. Нужны потому, что
      // Supabase прячет текст исключения триггера за общим «Database error saving new user».
      check_invite: {
        Args: { p_token: string };
        Returns: InviteCheck;
      };
      login_taken: {
        Args: { p_login: string };
        Returns: boolean;
      };
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};
