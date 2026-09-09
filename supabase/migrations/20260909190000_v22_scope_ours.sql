-- v22 (владелец, 2026-09-09): охват «Только наши» считает БАЗА, а не только клиент.
--
-- Владелец: «на „Только наши" хочу статистику только по нашим; поменять местами, чтобы
-- по умолчанию показывалось „Только наши", а по всем — по желанию».
--
-- Что было (v21 и раньше): охват жил только на клиенте и действовал на то, что страница
-- считает сама из видео («Лучшие видео», таблица, публикации по дням). Плитки, «Динамика»,
-- тренд площадок и «Лучшие креаторы» приходят суммами из базы, а база про пометки не знала —
-- поэтому под полосой периода висела серая строка «охват не действует на…».
--
-- Что стало: у всех четырёх функций появился `p_only_ours boolean default false`, и отбор
-- видео получает одно общее условие
--     and (not p_only_ours or v.ours or v.watch)
-- «Наши» = `videos.ours` ИЛИ `videos.watch`: жёлтое видео мы ведём так же, просто без
-- подробностей (`src/lib/video-state.ts`, миграция v17). Определение то же, что у клиентского
-- `matchesScope`, — иначе таблица и плитка на одной странице считали бы разные наборы.
--
-- ⚠️ Подписчики охвату не подчиняются и подчиняться не могут: у аккаунта пометки «наше» нет
-- вовсе. `followers_now` / `followers_delta` считаются по снимкам профиля, как и раньше.
--
-- ⚠️ Параметр добавлен со значением по умолчанию, но старые трёх- и двухаргументные функции
-- всё равно СНОСЯТСЯ: PostgREST разбирает перегрузки по именам параметров запроса, и две
-- функции с одним именем дают «Could not choose the best candidate function».

drop function if exists public.daily_views_all(timestamptz, timestamptz, text);
drop function if exists public.creator_daily_views(uuid, timestamptz, timestamptz);
drop function if exists public.creators_overview(timestamptz, timestamptz);
drop function if exists public.video_stats_between(uuid, timestamptz, timestamptz);

-- 1. Дневные ряды: день = что набрали ролики, вышедшие в этот день (правило v21).

create or replace function public.daily_views_all(
  p_from timestamptz,
  p_to timestamptz,
  p_platform text default null,
  p_only_ours boolean default false
)
returns table (day date, views bigint, likes bigint, comments bigint, shares bigint, saves bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with days as (
    select generate_series(date_trunc('day', p_from), date_trunc('day', p_to), interval '1 day')::date as day
  ),
  -- Границы отбора — те же, что у creators_overview и video_stats_between: иначе сумма
  -- графика перестала бы сходиться с плиткой на краях срока. Охват — тоже общий.
  vids as (
    select v.id, date_trunc('day', v.published_at)::date as day
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
  p_only_ours boolean default false
)
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
    select v.id, date_trunc('day', v.published_at)::date as day
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

-- 2. Итоги за срок — то же правило и тот же охват, чтобы плитка была суммой графика.
--
-- ⚠️ `videos_total` и `videos_published` тоже считают только наши, когда охват сужен: иначе
-- в столбце «Видео» стояло бы число, к которому просмотры рядом отношения не имеют.
create or replace function public.creators_overview(
  p_from timestamptz,
  p_to timestamptz,
  p_only_ours boolean default false
)
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
    select
      v.creator_id,
      coalesce(f.views, 0) as views_delta,
      coalesce(f.likes, 0) as likes_delta,
      coalesce(f.comments, 0) as comments_delta,
      coalesce(f.shares, 0) as shares_delta,
      coalesce(f.saves, 0) as saves_delta
    from vis
    join public.videos v on v.creator_id = vis.id
      and v.published_at >= p_from and v.published_at <= p_to
      and (not p_only_ours or v.ours or v.watch)
    left join lateral (
      select s.views, s.likes, s.comments, s.shares, s.saves from public.video_snaps s
      where s.video_id = v.id and s.taken_at <= p_to order by s.taken_at desc limit 1
    ) f on true
  )
  select
    vis.id,
    fn.followers,
    case when fn.followers is null then null else fn.followers - coalesce(fb.followers, ff.followers) end,
    (select count(*) from public.videos v where v.creator_id = vis.id
       and (not p_only_ours or v.ours or v.watch)),
    (select count(*) from public.videos v where v.creator_id = vis.id
       and v.published_at >= p_from and v.published_at <= p_to
       and (not p_only_ours or v.ours or v.watch)),
    coalesce((select sum(pv.views_delta)    from per_video pv where pv.creator_id = vis.id), 0),
    coalesce((select sum(pv.likes_delta)    from per_video pv where pv.creator_id = vis.id), 0),
    coalesce((select sum(pv.comments_delta) from per_video pv where pv.creator_id = vis.id), 0),
    coalesce((select sum(pv.shares_delta)   from per_video pv where pv.creator_id = vis.id), 0),
    coalesce((select sum(pv.saves_delta)    from per_video pv where pv.creator_id = vis.id), 0),
    (select percentile_cont(0.5) within group (order by pv.views_delta) from per_video pv where pv.creator_id = vis.id and pv.views_delta > 0)
  from vis
  left join fol_now fn on fn.creator_id = vis.id
  left join fol_before fb on fb.creator_id = vis.id
  left join fol_first_inside ff on ff.creator_id = vis.id;
$$;

-- Строки видео в карточке креатора. Охват сужен — «не наши» строки не приходят вовсе,
-- и таблица на странице совпадает с плитками над ней.
create or replace function public.video_stats_between(
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
    select v.id, v.published_at, v.caption, v.cover_url, v.url, v.ours
    from public.videos v
    where v.creator_id = p_creator
      and (not p_only_ours or v.ours or v.watch)
  ),
  finish as (
    select distinct on (s.video_id) s.video_id, s.views, s.likes, s.comments, s.shares, s.saves
    from public.video_snaps s
    join vids on vids.id = s.video_id
    where s.taken_at <= p_to
    order by s.video_id, s.taken_at desc
  )
  select
    vids.id, vids.published_at, vids.caption, vids.cover_url, vids.url, vids.ours,
    f.views, f.likes, f.comments, f.shares, f.saves,
    case when vids.published_at >= p_from and vids.published_at <= p_to then coalesce(f.views, 0)    else 0 end,
    case when vids.published_at >= p_from and vids.published_at <= p_to then coalesce(f.likes, 0)    else 0 end,
    case when vids.published_at >= p_from and vids.published_at <= p_to then coalesce(f.comments, 0) else 0 end,
    case when vids.published_at >= p_from and vids.published_at <= p_to then coalesce(f.shares, 0)   else 0 end,
    case when vids.published_at >= p_from and vids.published_at <= p_to then coalesce(f.saves, 0)    else 0 end
  from vids
  join finish f on f.video_id = vids.id
  order by vids.published_at desc nulls last;
$$;

-- Права: анониму эти функции не нужны, как и прежде.
revoke execute on function public.daily_views_all(timestamptz, timestamptz, text, boolean) from anon;
revoke execute on function public.creator_daily_views(uuid, timestamptz, timestamptz, boolean) from anon;
revoke execute on function public.creators_overview(timestamptz, timestamptz, boolean) from anon;
revoke execute on function public.video_stats_between(uuid, timestamptz, timestamptz, boolean) from anon;
