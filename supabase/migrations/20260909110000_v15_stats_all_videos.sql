-- v15 (владелец, 2026-09-08/09): общие счётчики считаются по ВСЕМ видео креатора.
--
-- Правило от 07.09 «в статистику идут только наши видео» отменено. Теперь:
-- - просмотры, лайки, число комментариев, репосты, сохранения — по всем собранным видео;
-- - `videos.ours` означает только «снимать подробности» (тексты комментариев и ветки),
--   и на суммы, медианы, графики и счётчики видео больше не влияет;
-- - поле `ours` из выдачи не убирается: сайт им помечает строки в таблице.
-- Симптом старого правила: у креатора без единого помеченного видео сводка пустая.
--
-- Переобъявляются последние версии трёх функций, без условия по `ours`:
--   creators_overview(timestamptz, timestamptz)              — последняя из v2_roles_api
--   daily_views_all(timestamptz, timestamptz, text)          — последняя из v10_platform_filter
--   creator_daily_views(uuid, timestamptz, timestamptz)      — последняя из v4_daily_series
-- `video_stats_between` уже отдаёт все видео креатора (фильтровал сайт) — не трогаем.
-- Индекс `videos_creator_ours_idx` тоже остаётся: по нему ходит сборщик подробностей.

-- Сводка по видимым креаторам за срок. Отличие от версии v2: `and v.ours` убрано из
-- обхода видео и из обоих счётчиков (videos_total, videos_published).
create or replace function public.creators_overview(p_from timestamptz, p_to timestamptz)
returns table (
  creator_id        uuid,
  followers_now     bigint,
  followers_delta   bigint,
  videos_total      bigint,
  videos_published  bigint,
  views_delta       bigint,
  likes_delta       bigint,
  comments_delta    bigint,
  shares_delta      bigint,
  saves_delta       bigint,
  median_views_delta double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  with vis as (
    select c.id from public.creators c   -- RLS сама оставит видимых
  ),
  fol_now as (
    select distinct on (s.creator_id) s.creator_id, s.followers
    from public.creator_snaps s join vis on vis.id = s.creator_id
    where s.taken_at <= p_to order by s.creator_id, s.taken_at desc
  ),
  fol_before as (
    select distinct on (s.creator_id) s.creator_id, s.followers
    from public.creator_snaps s join vis on vis.id = s.creator_id
    where s.taken_at <= p_from order by s.creator_id, s.taken_at desc
  ),
  fol_first_inside as (
    select distinct on (s.creator_id) s.creator_id, s.followers
    from public.creator_snaps s join vis on vis.id = s.creator_id
    where s.taken_at > p_from and s.taken_at <= p_to order by s.creator_id, s.taken_at asc
  ),
  per_video as (
    select v.creator_id, st.*
    from vis
    join public.videos v on v.creator_id = vis.id
    cross join lateral (
      select
        f.views  - coalesce(b.views,  case when v.published_at >= p_from then 0 else fi.views  end, 0) as views_delta,
        f.likes  - coalesce(b.likes,  case when v.published_at >= p_from then 0 else fi.likes  end, 0) as likes_delta,
        f.comments - coalesce(b.comments, case when v.published_at >= p_from then 0 else fi.comments end, 0) as comments_delta,
        f.shares - coalesce(b.shares, case when v.published_at >= p_from then 0 else fi.shares end, 0) as shares_delta,
        f.saves  - coalesce(b.saves,  case when v.published_at >= p_from then 0 else fi.saves  end, 0) as saves_delta
      from (
        select s.views, s.likes, s.comments, s.shares, s.saves from public.video_snaps s
        where s.video_id = v.id and s.taken_at <= p_to order by s.taken_at desc limit 1
      ) f
      left join lateral (
        select s.views, s.likes, s.comments, s.shares, s.saves from public.video_snaps s
        where s.video_id = v.id and s.taken_at <= p_from order by s.taken_at desc limit 1
      ) b on true
      left join lateral (
        select s.views, s.likes, s.comments, s.shares, s.saves from public.video_snaps s
        where s.video_id = v.id and s.taken_at > p_from and s.taken_at <= p_to order by s.taken_at asc limit 1
      ) fi on true
    ) st
  )
  select
    vis.id,
    fn.followers,
    case when fn.followers is null then null else fn.followers - coalesce(fb.followers, ff.followers) end,
    (select count(*) from public.videos v where v.creator_id = vis.id),
    (select count(*) from public.videos v where v.creator_id = vis.id and v.published_at >= p_from and v.published_at <= p_to),
    coalesce((select sum(greatest(pv.views_delta, 0))    from per_video pv where pv.creator_id = vis.id), 0),
    coalesce((select sum(greatest(pv.likes_delta, 0))    from per_video pv where pv.creator_id = vis.id), 0),
    coalesce((select sum(greatest(pv.comments_delta, 0)) from per_video pv where pv.creator_id = vis.id), 0),
    coalesce((select sum(greatest(pv.shares_delta, 0))   from per_video pv where pv.creator_id = vis.id), 0),
    coalesce((select sum(greatest(pv.saves_delta, 0))    from per_video pv where pv.creator_id = vis.id), 0),
    (select percentile_cont(0.5) within group (order by greatest(pv.views_delta, 0)) from per_video pv where pv.creator_id = vis.id and pv.views_delta > 0)
  from vis
  left join fol_now fn on fn.creator_id = vis.id
  left join fol_before fb on fb.creator_id = vis.id
  left join fol_first_inside ff on ff.creator_id = vis.id;
$$;

-- График на главной. Отличие от версии v10: видео берутся все, фильтр площадки на месте.
create or replace function public.daily_views_all(p_from timestamptz, p_to timestamptz, p_platform text default null)
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
    join public.videos v on true
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

-- График в карточке креатора. Отличие от версии v4: `and v.ours` убрано.
create or replace function public.creator_daily_views(p_creator uuid, p_from timestamptz, p_to timestamptz)
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
    join public.videos v on v.creator_id = p_creator
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

-- create or replace права сохраняет, но повторяем явно — чтобы правило было видно в файле.
revoke execute on function public.creators_overview(timestamptz, timestamptz) from anon;
revoke execute on function public.daily_views_all(timestamptz, timestamptz, text) from anon;
revoke execute on function public.creator_daily_views(uuid, timestamptz, timestamptz) from anon;
