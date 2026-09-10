-- v26: шаг дневных рядов — день, неделя или месяц.
-- Владелец, 2026-09-10: «выборка за год отображается криво». Причина: ряд строился на каждый
-- день (`generate_series`), за пять лет это 1826 строк, а PostgREST молча режет ответ на 1000 —
-- хвост графика не доезжал; да и тысяча точек на экране нечитаема. Теперь шаг приходит
-- параметром: сайт берёт день до двух месяцев, неделю до года с небольшим, дальше месяц.
-- Смысл значения не меняется: точка = что набрали ролики, вышедшие в этот отрезок (правило v21),
-- границы и охват — те же, что у creators_overview (v22), поэтому сумма графика по-прежнему
-- сходится с плиткой при любом шаге.

drop function if exists public.daily_views_all(timestamptz, timestamptz, text, boolean);
drop function if exists public.creator_daily_views(uuid, timestamptz, timestamptz, boolean);

create or replace function public.daily_views_all(
  p_from timestamptz,
  p_to timestamptz,
  p_platform text default null,
  p_only_ours boolean default false,
  p_bucket text default 'day'
)
returns table (day date, views bigint, likes bigint, comments bigint, shares bigint, saves bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with cfg as (
    -- Незнакомое слово — день: параметр приходит снаружи, и подставлять его в date_trunc
    -- без проверки нельзя.
    select case when p_bucket in ('week', 'month') then p_bucket else 'day' end as b
  ),
  days as (
    select generate_series(
      date_trunc((select b from cfg), p_from),
      date_trunc((select b from cfg), p_to),
      ('1 ' || (select b from cfg))::interval
    )::date as day
  ),
  vids as (
    select v.id, date_trunc((select b from cfg), v.published_at)::date as day
    from public.videos v
    join public.creators c on c.id = v.creator_id   -- RLS оставит видимых
      and (p_platform is null or c.platform = p_platform)
    where v.published_at >= p_from and v.published_at <= p_to
      and (not p_only_ours or v.ours or v.watch)
  ),
  cur as (
    select
      v.day,
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
  select dd.day,
         coalesce(sum(c.views), 0)::bigint, coalesce(sum(c.likes), 0)::bigint,
         coalesce(sum(c.comments), 0)::bigint, coalesce(sum(c.shares), 0)::bigint,
         coalesce(sum(c.saves), 0)::bigint
  from days dd
  left join cur c on c.day = dd.day
  group by dd.day
  order by dd.day;
$$;

create or replace function public.creator_daily_views(
  p_creator uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_only_ours boolean default false,
  p_bucket text default 'day'
)
returns table (day date, views bigint, likes bigint, comments bigint, shares bigint, saves bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with cfg as (
    select case when p_bucket in ('week', 'month') then p_bucket else 'day' end as b
  ),
  days as (
    select generate_series(
      date_trunc((select b from cfg), p_from),
      date_trunc((select b from cfg), p_to),
      ('1 ' || (select b from cfg))::interval
    )::date as day
  ),
  vids as (
    select v.id, date_trunc((select b from cfg), v.published_at)::date as day
    from public.videos v
    where v.creator_id = p_creator
      and v.published_at >= p_from and v.published_at <= p_to
      and (not p_only_ours or v.ours or v.watch)
  ),
  cur as (
    select
      v.day,
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
  select dd.day,
         coalesce(sum(c.views), 0)::bigint, coalesce(sum(c.likes), 0)::bigint,
         coalesce(sum(c.comments), 0)::bigint, coalesce(sum(c.shares), 0)::bigint,
         coalesce(sum(c.saves), 0)::bigint
  from days dd
  left join cur c on c.day = dd.day
  group by dd.day
  order by dd.day;
$$;

comment on function public.daily_views_all(timestamptz, timestamptz, text, boolean, text)
  is 'Ряд по дням/неделям/месяцам: точка = счётчики роликов, вышедших в этот отрезок.';
comment on function public.creator_daily_views(uuid, timestamptz, timestamptz, boolean, text)
  is 'То же по одному креатору.';
