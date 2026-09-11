-- v28: шаг ряда в десять минут.
-- Владелец, 2026-09-11: «сделай ещё точнее, буквально до десяти минут». Для коротких сроков
-- (сегодня, вчера-сегодня) час — всё ещё грубо: у роликов есть точное время публикации.
-- `date_trunc` десятиминутки не умеет, поэтому для них берётся `date_bin` от опорной точки;
-- остальные шаги (час, день, неделя, месяц) считаются как раньше. Смысл значения прежний:
-- точка = счётчики роликов, вышедших в этот отрезок, сумма ряда = плитке.

-- Начало отрезка в местном времени: одно место на обе функции, чтобы сетка и раскладка
-- роликов не разъехались. `immutable` — считается от аргументов и ничего не читает.
create or replace function public.bucket_start(p_at timestamp, p_bucket text)
returns timestamp
language sql
immutable
set search_path = ''
as $fn$
  select case
    when p_bucket = '10min'
      then date_bin(interval '10 minutes', p_at, timestamp '2000-01-01 00:00:00')
    when p_bucket in ('hour', 'week', 'month') then date_trunc(p_bucket, p_at)
    else date_trunc('day', p_at)
  end;
$fn$;

drop function if exists public.daily_views_all(timestamptz, timestamptz, text, boolean, text);
drop function if exists public.creator_daily_views(uuid, timestamptz, timestamptz, boolean, text);

create or replace function public.daily_views_all(
  p_from timestamptz,
  p_to timestamptz,
  p_platform text default null,
  p_only_ours boolean default false,
  p_bucket text default 'day',
  p_tz text default 'UTC'
)
returns table (day date, "at" timestamptz, views bigint, likes bigint, comments bigint, shares bigint, saves bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with cfg as (
    -- Оба параметра приходят снаружи: слово шага подставляется в date_trunc, имя пояса — в
    -- at time zone, поэтому незнакомое не пропускаем (шаг — день, пояс — UTC).
    select
      case when p_bucket in ('10min', 'hour', 'week', 'month') then p_bucket else 'day' end as b,
      case when exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_tz)
           then p_tz else 'UTC' end as tz
  ),
  -- Сетка отрезков в местном времени пояса: начало каждого — местные часы без пояса.
  slots as (
    select g as ls
    from cfg, generate_series(
      public.bucket_start(p_from at time zone cfg.tz, cfg.b),
      public.bucket_start(p_to at time zone cfg.tz, cfg.b),
      case when cfg.b = '10min' then interval '10 minutes' else ('1 ' || cfg.b)::interval end
    ) g
  ),
  vids as (
    select v.id, public.bucket_start(v.published_at at time zone cfg.tz, cfg.b) as ls
    from cfg, public.videos v
    join public.creators c on c.id = v.creator_id   -- RLS оставит видимых
      and (p_platform is null or c.platform = p_platform)
    where v.published_at >= p_from and v.published_at <= p_to
      and (not p_only_ours or v.ours or v.watch)
  ),
  cur as (
    select
      v.ls,
      coalesce(s.views, 0) as views,
      coalesce(s.likes, 0) as likes,
      coalesce(s.comments, 0) as comments,
      coalesce(s.shares, 0) as shares,
      coalesce(s.saves, 0) as saves
    from vids v
    left join lateral (
      select s.views, s.likes, s.comments, s.shares, s.saves
      from public.video_snaps s
      where s.video_id = v.id and s.taken_at <= p_to
      order by s.taken_at desc limit 1
    ) s on true
  )
  select sl.ls::date,
         sl.ls at time zone (select tz from cfg),
         coalesce(sum(c.views), 0)::bigint, coalesce(sum(c.likes), 0)::bigint,
         coalesce(sum(c.comments), 0)::bigint, coalesce(sum(c.shares), 0)::bigint,
         coalesce(sum(c.saves), 0)::bigint
  from slots sl
  left join cur c on c.ls = sl.ls
  group by sl.ls
  order by sl.ls;
$$;

create or replace function public.creator_daily_views(
  p_creator uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_only_ours boolean default false,
  p_bucket text default 'day',
  p_tz text default 'UTC'
)
returns table (day date, "at" timestamptz, views bigint, likes bigint, comments bigint, shares bigint, saves bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with cfg as (
    select
      case when p_bucket in ('10min', 'hour', 'week', 'month') then p_bucket else 'day' end as b,
      case when exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_tz)
           then p_tz else 'UTC' end as tz
  ),
  slots as (
    select g as ls
    from cfg, generate_series(
      public.bucket_start(p_from at time zone cfg.tz, cfg.b),
      public.bucket_start(p_to at time zone cfg.tz, cfg.b),
      case when cfg.b = '10min' then interval '10 minutes' else ('1 ' || cfg.b)::interval end
    ) g
  ),
  vids as (
    select v.id, public.bucket_start(v.published_at at time zone cfg.tz, cfg.b) as ls
    from cfg, public.videos v
    where v.creator_id = p_creator
      and v.published_at >= p_from and v.published_at <= p_to
      and (not p_only_ours or v.ours or v.watch)
  ),
  cur as (
    select
      v.ls,
      coalesce(s.views, 0) as views,
      coalesce(s.likes, 0) as likes,
      coalesce(s.comments, 0) as comments,
      coalesce(s.shares, 0) as shares,
      coalesce(s.saves, 0) as saves
    from vids v
    left join lateral (
      select s.views, s.likes, s.comments, s.shares, s.saves
      from public.video_snaps s
      where s.video_id = v.id and s.taken_at <= p_to
      order by s.taken_at desc limit 1
    ) s on true
  )
  select sl.ls::date,
         sl.ls at time zone (select tz from cfg),
         coalesce(sum(c.views), 0)::bigint, coalesce(sum(c.likes), 0)::bigint,
         coalesce(sum(c.comments), 0)::bigint, coalesce(sum(c.shares), 0)::bigint,
         coalesce(sum(c.saves), 0)::bigint
  from slots sl
  left join cur c on c.ls = sl.ls
  group by sl.ls
  order by sl.ls;
$$;

-- Как у всех статистических функций до v26: гостю без входа они ни к чему (v26 это забыл).
revoke execute on function public.daily_views_all(timestamptz, timestamptz, text, boolean, text, text) from anon;
revoke execute on function public.creator_daily_views(uuid, timestamptz, timestamptz, boolean, text, text) from anon;

comment on function public.daily_views_all(timestamptz, timestamptz, text, boolean, text, text)
  is 'Ряд по часам/дням/неделям/месяцам в поясе p_tz: точка = счётчики роликов, вышедших в этот отрезок.';
comment on function public.creator_daily_views(uuid, timestamptz, timestamptz, boolean, text, text)
  is 'То же по одному креатору.';
