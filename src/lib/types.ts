// Типы строк — вручную, по supabase/migrations/ (init → videos_ours → v2_roles_api).
// Меняется схема — меняется этот файл в тот же заход.

export type Platform = "tiktok" | "instagram";
// retry — повтор через час после неудачного обхода по расписанию, заводит сборщик (миграция v7).
export type SyncTrigger = "schedule" | "catchup" | "manual" | "retry";
// Глубина обхода (миграция v7): all — весь список видео, week — только за последние 7 дней.
export type SyncDepth = "all" | "week";
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
  // Галочка «все видео наши»: новые видео этого креатора считаются в статистике.
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
  // «Наше» — считается в статистике; ставит триггер по галочке креатора, меняет пользователь.
  ours: boolean;
  // Когда сборщик последний раз снимал тексты комментариев (миграция v11); null — ещё не снимал.
  comments_synced_at: string | null;
};

export type VideoUpdate = { ours?: boolean };

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
  // База сама (pg_cron) написала владельцу в Telegram: просьбу никто не принял за 3 минуты.
  notified_at: string | null;
};

// Остальное ставит база: requested_at и depth — по умолчанию, taken_at и run_id — сборщик.
export type SyncRequestInsert = { requested_by: string; creator_id?: string | null; depth?: SyncDepth };

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

// Результат RPC video_stats_between.
export type VideoStats = {
  video_id: string;
  published_at: string | null;
  caption: string;
  cover_url: string | null;
  url: string;
  // «Наше»: суммы и медианы сайт считает только по таким строкам.
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

// Результат RPC creator_daily_views и daily_views_all (миграция v4): пять счётчиков
// на конец каждого дня. Значения накопительные — «по дням» сайт считает разностью.
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
      video_stats_between: {
        Args: { p_creator: string; p_from: string; p_to: string };
        Returns: VideoStats[];
      };
      creator_daily_views: {
        Args: { p_creator: string; p_from: string; p_to: string };
        Returns: DailyViews[];
      };
      creators_overview: {
        Args: { p_from: string; p_to: string };
        Returns: CreatorOverview[];
      };
      // p_platform необязателен (миграция v10): null — все площадки.
      daily_views_all: {
        Args: { p_from: string; p_to: string; p_platform?: string | null };
        Returns: DailyViews[];
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
