-- Amestat — схема базы. Контракт двух проектов: сайт (этот репозиторий) и сборщик
-- внутри Sashboard. Меняешь таблицу — правишь сборщик в тот же заход (устав обоих проектов).
--
-- Площадки отдают только накопительные счётчики, поэтому вся статистика «за срок» — это
-- разность двух наших снимков. Снимки не удаляются никогда.

-- ---------------------------------------------------------------------------------------
-- Креаторы
-- ---------------------------------------------------------------------------------------

create table public.creators (
  id             uuid primary key default gen_random_uuid(),
  platform       text not null default 'tiktok' check (platform in ('tiktok', 'instagram')),
  handle         text not null,                       -- @имя без «@», как в адресе профиля
  display_name   text not null default '',
  description    text not null default '',
  profile_url    text not null,
  -- Картинка: своя, если владелец загрузил (avatar_custom), иначе аватар площадки,
  -- который сборщик обновляет при каждом обходе.
  avatar_url     text,
  avatar_custom  boolean not null default false,
  sort_order     integer not null default 0,          -- порядок руками; равные — по added_at
  added_at       timestamptz not null default now(),
  last_synced_at timestamptz,                         -- последний удачный обход этого креатора
  sync_error     text,                                -- текст последней ошибки; null — всё хорошо
  unique (platform, handle)
);

comment on table public.creators is 'Кого мониторим. Пишут и сайт (заведение, порядок, описание), и сборщик (аватар, last_synced_at, sync_error).';

create table public.tags (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  color      text not null default '#6B7280',         -- #RRGGBB
  created_at timestamptz not null default now()
);

create table public.creator_tags (
  creator_id uuid not null references public.creators (id) on delete cascade,
  tag_id     uuid not null references public.tags (id) on delete cascade,
  primary key (creator_id, tag_id)
);

create index creator_tags_tag_idx on public.creator_tags (tag_id);

-- ---------------------------------------------------------------------------------------
-- Снимки
-- ---------------------------------------------------------------------------------------

create table public.creator_snaps (
  id           bigint generated always as identity primary key,
  creator_id   uuid not null references public.creators (id) on delete cascade,
  taken_at     timestamptz not null default now(),
  followers    bigint,
  following    bigint,
  likes_total  bigint,
  videos_count integer
);

create index creator_snaps_creator_time_idx on public.creator_snaps (creator_id, taken_at desc);

create table public.videos (
  id            text primary key,                    -- id видео на площадке
  creator_id    uuid not null references public.creators (id) on delete cascade,
  published_at  timestamptz,
  caption       text not null default '',
  cover_url     text,
  url           text not null,
  duration_s    integer,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()   -- когда видео последний раз было в списке
);

create index videos_creator_published_idx on public.videos (creator_id, published_at desc);

create table public.video_snaps (
  id       bigint generated always as identity primary key,
  video_id text not null references public.videos (id) on delete cascade,
  taken_at timestamptz not null default now(),
  views    bigint,
  likes    bigint,
  comments bigint,
  shares   bigint,
  saves    bigint
);

create index video_snaps_video_time_idx on public.video_snaps (video_id, taken_at desc);

-- ---------------------------------------------------------------------------------------
-- Мост сайт ⇄ сборщик
-- ---------------------------------------------------------------------------------------

-- Кнопка «обновить» на сайте. Сборщик слушает вставки через Realtime и ставит taken_at,
-- когда забрал просьбу; run_id — обход, который её выполнил.
create table public.sync_requests (
  id           bigint generated always as identity primary key,
  requested_at timestamptz not null default now(),
  creator_id   uuid references public.creators (id) on delete cascade, -- null — обойти всех
  taken_at     timestamptz,
  run_id       bigint
);

create index sync_requests_open_idx on public.sync_requests (requested_at) where taken_at is null;

-- Каждый обход — строка. Сайт показывает время и исход последнего обновления отсюда.
create table public.sync_runs (
  id              bigint generated always as identity primary key,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  trigger         text not null check (trigger in ('schedule', 'catchup', 'manual')),
  ok              boolean,                            -- null, пока идёт
  error           text,
  creators_done   integer not null default 0,
  creators_failed integer not null default 0,
  log             text not null default ''
);

create index sync_runs_started_idx on public.sync_runs (started_at desc);

alter table public.sync_requests replica identity full;
alter publication supabase_realtime add table public.sync_requests;
-- Сайт слушает изменения обходов, чтобы «обновить» на экране сменилось на «готово» само.
alter publication supabase_realtime add table public.sync_runs;

-- ---------------------------------------------------------------------------------------
-- Картинки креаторов, загруженные владельцем. Публичное чтение — адрес картинки уходит
-- в <img> без токена; писать может только вошедший.
-- ---------------------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "anyone reads avatars"   on storage.objects for select using (bucket_id = 'avatars');
create policy "owner uploads avatars"  on storage.objects for insert to authenticated with check (bucket_id = 'avatars');
create policy "owner replaces avatars" on storage.objects for update to authenticated using (bucket_id = 'avatars') with check (bucket_id = 'avatars');
create policy "owner deletes avatars"  on storage.objects for delete to authenticated using (bucket_id = 'avatars');

-- ---------------------------------------------------------------------------------------
-- Доступ. Пользователь один — владелец; регистрация в Auth выключена руками в панели.
-- Сборщик ходит с service_role и RLS не подчиняется.
-- ---------------------------------------------------------------------------------------

alter table public.creators      enable row level security;
alter table public.tags          enable row level security;
alter table public.creator_tags  enable row level security;
alter table public.creator_snaps enable row level security;
alter table public.videos        enable row level security;
alter table public.video_snaps   enable row level security;
alter table public.sync_requests enable row level security;
alter table public.sync_runs     enable row level security;

create policy "owner reads creators"       on public.creators      for select to authenticated using (true);
create policy "owner writes creators"      on public.creators      for insert to authenticated with check (true);
create policy "owner updates creators"     on public.creators      for update to authenticated using (true) with check (true);
create policy "owner deletes creators"     on public.creators      for delete to authenticated using (true);

create policy "owner reads tags"           on public.tags          for select to authenticated using (true);
create policy "owner writes tags"          on public.tags          for insert to authenticated with check (true);
create policy "owner updates tags"         on public.tags          for update to authenticated using (true) with check (true);
create policy "owner deletes tags"         on public.tags          for delete to authenticated using (true);

create policy "owner reads creator_tags"   on public.creator_tags  for select to authenticated using (true);
create policy "owner writes creator_tags"  on public.creator_tags  for insert to authenticated with check (true);
create policy "owner deletes creator_tags" on public.creator_tags  for delete to authenticated using (true);

create policy "owner reads creator_snaps"  on public.creator_snaps for select to authenticated using (true);
create policy "owner reads videos"         on public.videos        for select to authenticated using (true);
create policy "owner reads video_snaps"    on public.video_snaps   for select to authenticated using (true);
create policy "owner reads sync_runs"      on public.sync_runs     for select to authenticated using (true);

create policy "owner reads sync_requests"  on public.sync_requests for select to authenticated using (true);
create policy "owner asks for sync"        on public.sync_requests for insert to authenticated with check (true);

-- ---------------------------------------------------------------------------------------
-- Представления: последний снимок. security_invoker — чтобы RLS таблиц действовал и здесь.
-- ---------------------------------------------------------------------------------------

create view public.creator_latest with (security_invoker = true) as
select distinct on (creator_id)
  creator_id, taken_at, followers, following, likes_total, videos_count
from public.creator_snaps
order by creator_id, taken_at desc;

create view public.video_latest with (security_invoker = true) as
select distinct on (video_id)
  video_id, taken_at, views, likes, comments, shares, saves
from public.video_snaps
order by video_id, taken_at desc;

-- ---------------------------------------------------------------------------------------
-- Статистика за срок: по каждому видео креатора — прирост между p_from и p_to.
--
-- «Начало» — последний снимок не позже p_from. Его нет (история началась позже) — тогда:
--   видео опубликовано после p_from  → начало = ноль, весь счётчик заработан в срок;
--   видео старше p_from              → начало = первый снимок внутри срока (то, что было
--                                       до него, мы не видели и не приписываем).
-- «Конец» — последний снимок не позже p_to. Видео без единого снимка до p_to не попадает.
-- ---------------------------------------------------------------------------------------

create function public.video_stats_between(p_creator uuid, p_from timestamptz, p_to timestamptz)
returns table (
  video_id      text,
  published_at  timestamptz,
  caption       text,
  cover_url     text,
  url           text,
  views_now     bigint,
  likes_now     bigint,
  comments_now  bigint,
  shares_now    bigint,
  saves_now     bigint,
  views_delta   bigint,
  likes_delta   bigint,
  comments_delta bigint,
  shares_delta  bigint,
  saves_delta   bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with vids as (
    select v.id, v.published_at, v.caption, v.cover_url, v.url
    from public.videos v
    where v.creator_id = p_creator
  ),
  finish as (
    select distinct on (s.video_id) s.video_id, s.views, s.likes, s.comments, s.shares, s.saves
    from public.video_snaps s
    join vids on vids.id = s.video_id
    where s.taken_at <= p_to
    order by s.video_id, s.taken_at desc
  ),
  before as (
    select distinct on (s.video_id) s.video_id, s.views, s.likes, s.comments, s.shares, s.saves
    from public.video_snaps s
    join vids on vids.id = s.video_id
    where s.taken_at <= p_from
    order by s.video_id, s.taken_at desc
  ),
  first_inside as (
    select distinct on (s.video_id) s.video_id, s.views, s.likes, s.comments, s.shares, s.saves
    from public.video_snaps s
    join vids on vids.id = s.video_id
    where s.taken_at > p_from and s.taken_at <= p_to
    order by s.video_id, s.taken_at asc
  ),
  start as (
    select
      vids.id as video_id,
      coalesce(b.views,    case when vids.published_at >= p_from then 0 else fi.views    end, 0) as views,
      coalesce(b.likes,    case when vids.published_at >= p_from then 0 else fi.likes    end, 0) as likes,
      coalesce(b.comments, case when vids.published_at >= p_from then 0 else fi.comments end, 0) as comments,
      coalesce(b.shares,   case when vids.published_at >= p_from then 0 else fi.shares   end, 0) as shares,
      coalesce(b.saves,    case when vids.published_at >= p_from then 0 else fi.saves    end, 0) as saves
    from vids
    left join before b on b.video_id = vids.id
    left join first_inside fi on fi.video_id = vids.id
  )
  select
    vids.id, vids.published_at, vids.caption, vids.cover_url, vids.url,
    f.views, f.likes, f.comments, f.shares, f.saves,
    greatest(coalesce(f.views, 0)    - st.views,    0),
    greatest(coalesce(f.likes, 0)    - st.likes,    0),
    greatest(coalesce(f.comments, 0) - st.comments, 0),
    greatest(coalesce(f.shares, 0)   - st.shares,   0),
    greatest(coalesce(f.saves, 0)    - st.saves,    0)
  from vids
  join finish f on f.video_id = vids.id
  join start st on st.video_id = vids.id
  order by vids.published_at desc nulls last;
$$;

-- Ряд по дням для графика: суммарные просмотры всех видео креатора на конец каждого дня.
create function public.creator_daily_views(p_creator uuid, p_from timestamptz, p_to timestamptz)
returns table (day date, views bigint, likes bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with days as (
    select generate_series(date_trunc('day', p_from), date_trunc('day', p_to), interval '1 day')::date as day
  ),
  per_video_day as (
    select distinct on (d.day, s.video_id) d.day, s.video_id, s.views, s.likes
    from days d
    join public.videos v on v.creator_id = p_creator
    join public.video_snaps s on s.video_id = v.id and s.taken_at < (d.day + 1)::timestamptz
    order by d.day, s.video_id, s.taken_at desc
  )
  select d.day, coalesce(sum(p.views), 0)::bigint, coalesce(sum(p.likes), 0)::bigint
  from days d
  left join per_video_day p on p.day = d.day
  group by d.day
  order by d.day;
$$;

revoke execute on function public.video_stats_between(uuid, timestamptz, timestamptz) from anon;
revoke execute on function public.creator_daily_views(uuid, timestamptz, timestamptz) from anon;
