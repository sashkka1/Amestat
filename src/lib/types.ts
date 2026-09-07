// Типы строк — вручную, по supabase/migrations/20260907142636_init.sql.
// Меняется схема — меняется этот файл в тот же заход.

export type Platform = "tiktok" | "instagram";
export type SyncTrigger = "schedule" | "catchup" | "manual";

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
};

export type CreatorUpdate = Partial<CreatorInsert>;

export type Tag = {
  id: string;
  name: string;
  color: string;
  created_at: string;
};

export type TagInsert = { id?: string; name: string; color?: string; created_at?: string };
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
  // «Наше» — считается в статистике; ставит триггер по галочке креатора, меняет владелец.
  ours: boolean;
};

export type VideoUpdate = { ours?: boolean };

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

export type SyncRequest = {
  id: number;
  requested_at: string;
  creator_id: string | null;
  taken_at: string | null;
  run_id: number | null;
};

export type SyncRequestInsert = {
  id?: never;
  requested_at?: string;
  creator_id?: string | null;
  taken_at?: string | null;
  run_id?: number | null;
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

// Результат RPC creator_daily_views.
export type DailyViews = { day: string; views: number; likes: number };

type Relationships = [];

// Схема в форме, которую понимает supabase-js: типизированные запросы и RPC.
export type Database = {
  public: {
    Tables: {
      creators: { Row: Creator; Insert: CreatorInsert; Update: CreatorUpdate; Relationships: Relationships };
      tags: { Row: Tag; Insert: TagInsert; Update: TagUpdate; Relationships: Relationships };
      creator_tags: { Row: CreatorTag; Insert: CreatorTag; Update: Partial<CreatorTag>; Relationships: Relationships };
      creator_snaps: { Row: CreatorSnap; Insert: never; Update: never; Relationships: Relationships };
      videos: { Row: Video; Insert: never; Update: VideoUpdate; Relationships: Relationships };
      video_snaps: { Row: VideoSnap; Insert: never; Update: never; Relationships: Relationships };
      sync_requests: { Row: SyncRequest; Insert: SyncRequestInsert; Update: never; Relationships: Relationships };
      sync_runs: { Row: SyncRun; Insert: never; Update: never; Relationships: Relationships };
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
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};
