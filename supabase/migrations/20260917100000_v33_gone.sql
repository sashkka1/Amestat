-- Версия 33 (владелец, 2026-09-17): удалённые видео и удалённые профили — отметкой в базе,
-- чтобы сайт их показывал помеченными, а не только письмом в Telegram.
--
-- «Есть практика, что аккаунты либо видосы будут удаляться… мне нужно, чтобы это приходило
-- [в письме] — это супер. Но в момент, когда приложение понимает, что видео удалено… чтобы
-- видео, которые не найдены, и креаторы тоже помечались как удалённые: затемнение, значок —
-- визуальное отображение, которое чётко даёт понять, что креатор или видео удалено».
--
-- Как было: сторож пропавших (`vanishedVideos` в сборщике) слал письмо и писал в лог, а база
-- о пропаже не знала; удалённый профиль оседал только текстом в `creators.sync_error`.
--
-- Как стало: две колонки-отметки, обе ставит и снимает ТОЛЬКО сборщик.
--   `videos.gone_at`   — когда впервые не нашлось в законченном списке площадки (похоже удалено).
--                        Снова встретилось в списке — отметка снимается: «удалено, возвращено и
--                        снова удалено» даст новую дату.
--   `creators.gone_at` — когда обход впервые получил «профиль не найден». Удачный обход снимает.
-- Дата — ПЕРВОЕ подозрение, повторные обходы её не двигают: сайту нужно «с какого дня».
--
-- ⚠️ Статистика отметку не учитывает нарочно: удалённое видео набрало свои просмотры, история
-- цела, суммы за прошлые сроки не меняются. Отметка — про то, как показать, а не что считать.
-- ⚠️ Это не архив (v32) и не пауза `sync_off`: карточка видна, обходы идут — вдруг вернётся.

alter table public.videos   add column gone_at timestamptz;
alter table public.creators add column gone_at timestamptz;

create index videos_gone_idx   on public.videos   (creator_id) where gone_at is not null;
create index creators_gone_idx on public.creators (gone_at)    where gone_at is not null;

comment on column public.videos.gone_at   is 'Когда видео впервые не нашлось в законченном списке площадки (похоже удалено). Ставит и снимает сборщик.';
comment on column public.creators.gone_at is 'Когда обход впервые получил «профиль не найден». Ставит и снимает сборщик.';

-- ---------------------------------------------------------------------------------------
-- Функции, отдающие строки видео, получают колонку. Тело — слово в слово v30, плюс gone_at.
-- Состав колонок меняется, поэтому `create or replace` не годится: сначала drop.
-- ---------------------------------------------------------------------------------------

drop function public.video_stats_between(uuid, timestamptz, timestamptz, boolean);

create function public.video_stats_between(
  p_creator uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_only_ours boolean default false
)
returns table (
  video_id       text,
  published_at   timestamptz,
  caption        text,
  cover_url      text,
  url            text,
  ours           boolean,
  gone_at        timestamptz,
  views_now      bigint,
  likes_now      bigint,
  comments_now   bigint,
  shares_now     bigint,
  saves_now      bigint,
  views_delta    bigint,
  likes_delta    bigint,
  comments_delta bigint,
  shares_delta   bigint,
  saves_delta    bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with vids as (
    select v.id, v.published_at, v.caption, v.cover_url, v.url, v.ours, v.gone_at
    from public.videos v
    where v.creator_id = p_creator
      and (not p_only_ours or v.ours or v.watch)
  )
  select
    vids.id, vids.published_at, vids.caption, vids.cover_url, vids.url, vids.ours, vids.gone_at,
    f.views, f.likes, f.comments, f.shares, f.saves,
    case when vids.published_at >= p_from and vids.published_at <= p_to then coalesce(f.views, 0)    else 0 end,
    case when vids.published_at >= p_from and vids.published_at <= p_to then coalesce(f.likes, 0)    else 0 end,
    case when vids.published_at >= p_from and vids.published_at <= p_to then coalesce(f.comments, 0) else 0 end,
    case when vids.published_at >= p_from and vids.published_at <= p_to then coalesce(f.shares, 0)   else 0 end,
    case when vids.published_at >= p_from and vids.published_at <= p_to then coalesce(f.saves, 0)    else 0 end
  from vids
  join lateral (
    select s.views, s.likes, s.comments, s.shares, s.saves
    from public.video_snaps s
    where s.video_id = vids.id
    order by (s.taken_at <= p_to) desc,
             case when s.taken_at <= p_to then s.taken_at end desc nulls last,
             s.taken_at asc
    limit 1
  ) f on true
  order by vids.published_at desc nulls last;
$$;

drop function public.videos_with_latest(timestamptz, timestamptz, uuid, text, boolean, int);

create function public.videos_with_latest(
  p_from timestamptz,
  p_to timestamptz,
  p_creator uuid default null,
  p_platform text default null,
  p_only_ours boolean default false,
  p_limit int default 500
)
returns table (
  id                    text,
  creator_id            uuid,
  published_at          timestamptz,
  caption               text,
  cover_url             text,
  url                   text,
  duration_s            integer,
  first_seen_at         timestamptz,
  last_seen_at          timestamptz,
  ours                  boolean,
  comments_synced_at    timestamptz,
  comments_synced_count integer,
  watch                 boolean,
  gone_at               timestamptz,
  views                 bigint,
  likes                 bigint,
  comments              bigint,
  shares                bigint,
  saves                 bigint,
  taken_at              timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    v.id, v.creator_id, v.published_at, v.caption, v.cover_url, v.url, v.duration_s,
    v.first_seen_at, v.last_seen_at, v.ours, v.comments_synced_at, v.comments_synced_count, v.watch,
    v.gone_at,
    coalesce(s.views, 0), coalesce(s.likes, 0), coalesce(s.comments, 0),
    coalesce(s.shares, 0), coalesce(s.saves, 0), s.taken_at
  from public.videos v
  join public.creators c on c.id = v.creator_id            -- RLS оставит видимых
    and (p_platform is null or c.platform = p_platform)
  left join lateral (
    select s.views, s.likes, s.comments, s.shares, s.saves, s.taken_at
    from public.video_snaps s
    where s.video_id = v.id
    order by (s.taken_at <= p_to) desc,
             case when s.taken_at <= p_to then s.taken_at end desc nulls last,
             s.taken_at asc
    limit 1
  ) s on true
  where v.published_at >= p_from and v.published_at <= p_to
    and (p_creator is null or v.creator_id = p_creator)
    and (not p_only_ours or v.ours or v.watch)
  order by v.published_at desc, v.id desc
  limit greatest(p_limit, 0);
$$;

comment on function public.video_stats_between(uuid, timestamptz, timestamptz, boolean)
  is 'Строки видео креатора. Снимок — последний не позже p_to, а нет такого — самый ранний известный. gone_at — отметка «похоже удалено» (v33).';
comment on function public.videos_with_latest(timestamptz, timestamptz, uuid, text, boolean, int)
  is 'Видео за срок со снимком: последний не позже p_to, а нет такого — самый ранний известный. gone_at — отметка «похоже удалено» (v33).';
