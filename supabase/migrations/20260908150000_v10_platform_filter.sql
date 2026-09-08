-- Версия 10 (2026-09-08): переключатель площадки на сайте — «Все / TikTok / Instagram».
--
-- Владелец: «сверху переключатель с тремя положениями: все, только TikTok, только Instagram —
-- на странице отображается всё по выбранному». Списки креаторов и видео сайт фильтрует сам
-- (у строк есть площадка креатора), а график по дням считает база — ему нужен параметр.
-- Функция пересоздаётся с необязательным p_platform: null — все площадки, как раньше.

drop function public.daily_views_all(timestamptz, timestamptz);

create function public.daily_views_all(p_from timestamptz, p_to timestamptz, p_platform text default null)
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
      and (p_platform is null or c.platform = p_platform)
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

revoke execute on function public.daily_views_all(timestamptz, timestamptz, text) from anon;
