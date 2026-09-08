-- Версия 4 (2026-09-08): график «Динамика» по пяти рядам, как на макете владельца —
-- к просмотрам и лайкам по дням добавляются комментарии, репосты и сохранения.
-- Обе функции пересоздаются с новым набором колонок; сайт читает их по именам.

drop function public.daily_views_all(timestamptz, timestamptz);
drop function public.creator_daily_views(uuid, timestamptz, timestamptz);

create function public.creator_daily_views(p_creator uuid, p_from timestamptz, p_to timestamptz)
returns table (day date, views bigint, likes bigint, comments bigint, shares bigint, saves bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with days as (
    select generate_series(date_trunc('day', p_from), date_trunc('day', p_to), interval '1 day')::date as day
  ),
  per_video_day as (
    select distinct on (d.day, s.video_id) d.day, s.video_id, s.views, s.likes, s.comments, s.shares, s.saves
    from days d
    join public.videos v on v.creator_id = p_creator and v.ours
    join public.video_snaps s on s.video_id = v.id and s.taken_at < (d.day + 1)::timestamptz
    order by d.day, s.video_id, s.taken_at desc
  )
  select d.day,
         coalesce(sum(p.views), 0)::bigint, coalesce(sum(p.likes), 0)::bigint,
         coalesce(sum(p.comments), 0)::bigint, coalesce(sum(p.shares), 0)::bigint, coalesce(sum(p.saves), 0)::bigint
  from days d
  left join per_video_day p on p.day = d.day
  group by d.day
  order by d.day;
$$;

create function public.daily_views_all(p_from timestamptz, p_to timestamptz)
returns table (day date, views bigint, likes bigint, comments bigint, shares bigint, saves bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with days as (
    select generate_series(date_trunc('day', p_from), date_trunc('day', p_to), interval '1 day')::date as day
  ),
  per_video_day as (
    select distinct on (d.day, s.video_id) d.day, s.video_id, s.views, s.likes, s.comments, s.shares, s.saves
    from days d
    join public.videos v on v.ours
    join public.creators c on c.id = v.creator_id   -- RLS оставит видимых
    join public.video_snaps s on s.video_id = v.id and s.taken_at < (d.day + 1)::timestamptz
    order by d.day, s.video_id, s.taken_at desc
  )
  select d.day,
         coalesce(sum(p.views), 0)::bigint, coalesce(sum(p.likes), 0)::bigint,
         coalesce(sum(p.comments), 0)::bigint, coalesce(sum(p.shares), 0)::bigint, coalesce(sum(p.saves), 0)::bigint
  from days d
  left join per_video_day p on p.day = d.day
  group by d.day
  order by d.day;
$$;

revoke execute on function public.creator_daily_views(uuid, timestamptz, timestamptz) from anon;
revoke execute on function public.daily_views_all(timestamptz, timestamptz) from anon;
