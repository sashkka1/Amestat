-- v20 (владелец, 2026-09-09): дневные ряды отдают ПРИРОСТ за день, а не накопленную сумму.
--
-- Симптом старого поведения: обе функции отдавали сумму последних снимков на конец дня, а сайт
-- вычитал соседние дни. День, в который у видео появился первый снимок, засчитывал всю его
-- историю как прирост — «сегодня 42,7 млн за день» при 1,29 млн за срок в плитке
-- creators_overview.
--
-- Теперь база считает прирост сама, по тем же правилам базовой линии, что и
-- `video_stats_between` (миграция videos_ours):
--   - у каждого видео за каждый день берётся ПОСЛЕДНИЙ снимок этого дня внутри срока;
--   - прирост дня = снимок дня − предыдущее значение;
--   - предыдущее значение — снимок предыдущего дня со снимком (тот же срок), а для первого
--     дня видео в сроке — базовая линия: снимок ДО срока; нет такого — 0, если видео
--     опубликовано внутри срока; иначе сам первый снимок внутри срока (то есть 0 прироста);
--   - отрицательный прирост (площадка занижает счётчик задним числом) гасится в 0;
--   - день без снимков — 0: сетку дней по-прежнему даёт generate_series.
-- Сумма по дням телескопируется в «последний снимок − базовая линия», то есть в ту же дельту
-- за срок, что показывают плитки; расхождение возможно только на гашении отрицательных дней.
--
-- Сигнатуры и наборы колонок те же, что у последних версий (v15): create or replace,
-- security invoker, set search_path = '', фильтр площадки у daily_views_all на месте.

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
  vids as (
    select v.id, v.published_at
    from public.videos v
    join public.creators c on c.id = v.creator_id   -- RLS оставит видимых
      and (p_platform is null or c.platform = p_platform)
  ),
  -- Последний снимок каждого видео за каждый день срока. День — тот же, что у generate_series
  -- выше: date_trunc в часовом поясе базы.
  day_snap as (
    select distinct on (s.video_id, date_trunc('day', s.taken_at))
      s.video_id,
      date_trunc('day', s.taken_at)::date as day,
      coalesce(s.views, 0) as views,
      coalesce(s.likes, 0) as likes,
      coalesce(s.comments, 0) as comments,
      coalesce(s.shares, 0) as shares,
      coalesce(s.saves, 0) as saves
    from public.video_snaps s
    join vids v on v.id = s.video_id
    where s.taken_at > p_from and s.taken_at <= p_to
    order by s.video_id, date_trunc('day', s.taken_at), s.taken_at desc
  ),
  -- Базовая линия видео — ровно как в video_stats_between.
  base as (
    select
      v.id as video_id,
      coalesce(b.views,    case when v.published_at >= p_from then 0 else fi.views    end, 0) as views,
      coalesce(b.likes,    case when v.published_at >= p_from then 0 else fi.likes    end, 0) as likes,
      coalesce(b.comments, case when v.published_at >= p_from then 0 else fi.comments end, 0) as comments,
      coalesce(b.shares,   case when v.published_at >= p_from then 0 else fi.shares   end, 0) as shares,
      coalesce(b.saves,    case when v.published_at >= p_from then 0 else fi.saves    end, 0) as saves
    from vids v
    left join lateral (
      select s.views, s.likes, s.comments, s.shares, s.saves from public.video_snaps s
      where s.video_id = v.id and s.taken_at <= p_from order by s.taken_at desc limit 1
    ) b on true
    left join lateral (
      select s.views, s.likes, s.comments, s.shares, s.saves from public.video_snaps s
      where s.video_id = v.id and s.taken_at > p_from and s.taken_at <= p_to
      order by s.taken_at asc limit 1
    ) fi on true
    -- Базовая линия нужна только видео, у которых в сроке есть хоть один день со снимком.
    where exists (select 1 from day_snap d where d.video_id = v.id)
  ),
  growth as (
    select
      d.day,
      greatest(d.views    - coalesce(lag(d.views)    over w, b.views),    0) as views,
      greatest(d.likes    - coalesce(lag(d.likes)    over w, b.likes),    0) as likes,
      greatest(d.comments - coalesce(lag(d.comments) over w, b.comments), 0) as comments,
      greatest(d.shares   - coalesce(lag(d.shares)   over w, b.shares),   0) as shares,
      greatest(d.saves    - coalesce(lag(d.saves)    over w, b.saves),    0) as saves
    from day_snap d
    join base b on b.video_id = d.video_id
    window w as (partition by d.video_id order by d.day)
  )
  select dd.day,
         coalesce(sum(g.views), 0)::bigint, coalesce(sum(g.likes), 0)::bigint,
         coalesce(sum(g.comments), 0)::bigint, coalesce(sum(g.shares), 0)::bigint,
         coalesce(sum(g.saves), 0)::bigint
  from days dd
  left join growth g on g.day = dd.day
  group by dd.day
  order by dd.day;
$$;

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
  vids as (
    select v.id, v.published_at
    from public.videos v
    where v.creator_id = p_creator
  ),
  day_snap as (
    select distinct on (s.video_id, date_trunc('day', s.taken_at))
      s.video_id,
      date_trunc('day', s.taken_at)::date as day,
      coalesce(s.views, 0) as views,
      coalesce(s.likes, 0) as likes,
      coalesce(s.comments, 0) as comments,
      coalesce(s.shares, 0) as shares,
      coalesce(s.saves, 0) as saves
    from public.video_snaps s
    join vids v on v.id = s.video_id
    where s.taken_at > p_from and s.taken_at <= p_to
    order by s.video_id, date_trunc('day', s.taken_at), s.taken_at desc
  ),
  base as (
    select
      v.id as video_id,
      coalesce(b.views,    case when v.published_at >= p_from then 0 else fi.views    end, 0) as views,
      coalesce(b.likes,    case when v.published_at >= p_from then 0 else fi.likes    end, 0) as likes,
      coalesce(b.comments, case when v.published_at >= p_from then 0 else fi.comments end, 0) as comments,
      coalesce(b.shares,   case when v.published_at >= p_from then 0 else fi.shares   end, 0) as shares,
      coalesce(b.saves,    case when v.published_at >= p_from then 0 else fi.saves    end, 0) as saves
    from vids v
    left join lateral (
      select s.views, s.likes, s.comments, s.shares, s.saves from public.video_snaps s
      where s.video_id = v.id and s.taken_at <= p_from order by s.taken_at desc limit 1
    ) b on true
    left join lateral (
      select s.views, s.likes, s.comments, s.shares, s.saves from public.video_snaps s
      where s.video_id = v.id and s.taken_at > p_from and s.taken_at <= p_to
      order by s.taken_at asc limit 1
    ) fi on true
    where exists (select 1 from day_snap d where d.video_id = v.id)
  ),
  growth as (
    select
      d.day,
      greatest(d.views    - coalesce(lag(d.views)    over w, b.views),    0) as views,
      greatest(d.likes    - coalesce(lag(d.likes)    over w, b.likes),    0) as likes,
      greatest(d.comments - coalesce(lag(d.comments) over w, b.comments), 0) as comments,
      greatest(d.shares   - coalesce(lag(d.shares)   over w, b.shares),   0) as shares,
      greatest(d.saves    - coalesce(lag(d.saves)    over w, b.saves),    0) as saves
    from day_snap d
    join base b on b.video_id = d.video_id
    window w as (partition by d.video_id order by d.day)
  )
  select dd.day,
         coalesce(sum(g.views), 0)::bigint, coalesce(sum(g.likes), 0)::bigint,
         coalesce(sum(g.comments), 0)::bigint, coalesce(sum(g.shares), 0)::bigint,
         coalesce(sum(g.saves), 0)::bigint
  from days dd
  left join growth g on g.day = dd.day
  group by dd.day
  order by dd.day;
$$;

-- create or replace права сохраняет, но повторяем явно — чтобы правило было видно в файле.
revoke execute on function public.daily_views_all(timestamptz, timestamptz, text) from anon;
revoke execute on function public.creator_daily_views(uuid, timestamptz, timestamptz) from anon;
