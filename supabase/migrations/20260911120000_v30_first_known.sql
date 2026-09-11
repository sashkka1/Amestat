-- v30 (владелец, 2026-09-11): «за месяц статистика есть, а если задать свой срок с 24 по
-- 30 августа — пусто».
--
-- ═══ Почему было пусто ═══
--
-- Счётчики ролика все статистические функции брали одинаково: «последний снимок с
-- `taken_at <= p_to`». Снимки в базе начинаются 2026-09-09 — сборщик раньше не ходил.
-- У периода, целиком лежащего в прошлом (24–30 августа), `p_to` = 30 августа, и снимка
-- не позже этой даты нет НИ У ОДНОГО видео. Дальше по функциям расходилось так:
--   • `daily_views_all` / `creator_daily_views` — `left join lateral` давал null, `coalesce`
--     превращал его в 0: ряд рисовался (168 точек за 24–30 августа), но суммой 0;
--   • `creators_overview` — то же самое: `videos_published` 14, просмотров 0;
--   • `video_stats_between` — там был ВНУТРЕННИЙ join с CTE `finish`, поэтому строки
--     не обнулялись, а пропадали вовсе: таблица видео пустая.
-- «Месяц» и «неделя» работали только потому, что у них `p_to` = сейчас, и последний снимок
-- всегда находится.
--
-- ═══ Что стало ═══
--
-- Правило выбора снимка: «последний снимок не позже `p_to`, а если такого нет — САМЫЙ
-- РАННИЙ известный снимок этого видео». Первое измеренное состояние честнее пустоты: мы
-- не знаем, сколько у ролика было просмотров 30 августа, но знаем, сколько их было в первый
-- раз, когда мы его увидели.
--
-- Делается это одним lateral, без второго прохода и без второго запроса:
--     order by (s.taken_at <= p_to) desc,                                  -- сначала «внутри срока»
--              case when s.taken_at <= p_to then s.taken_at end desc nulls last,  -- из них — последний
--              s.taken_at asc                                              -- иначе — самый ранний вообще
--     limit 1
--
-- ⚠️ На «сегодня», «неделю», «месяц» и любой срок с `p_to` = сейчас это не влияет ВООБЩЕ:
-- снимок не позже `p_to` есть, первая половина order by его и выбирает — ровно как раньше.
-- Меняются только сроки, кончающиеся раньше первого снимка.
--
-- ⚠️ `videos_with_latest` до сих пор брала последний снимок вообще, без оглядки на `p_to`
-- (так отдавал вид `video_latest`, который она заменила в v23). Теперь она живёт по тому же
-- правилу, что и плитки с графиком: на текущих сроках числа те же, а на сроке в прошлом
-- таблица «Новые видео» перестаёт спорить с плиткой над собой.
--
-- ⚠️ `cross_stats` (v29) к снимкам не обращается вовсе — считает по `video_comments` и
-- подписям, — поэтому здесь не пересоздаётся.
--
-- Сигнатуры не меняются ни у одной функции, поэтому дропов нет: `create or replace`
-- сохраняет и параметры с умолчаниями, и гранты, и `revoke ... from anon` от v22/v23/v28.
-- Всё прочее в телах — `p_tz`, `p_bucket`, `p_only_ours`, `p_platform`, `p_limit`, границы
-- отбора по `published_at`, `security invoker`, `set search_path = ''` — дословно как было.

-- ---------------------------------------------------------------------------------------
-- 1. Дневные ряды (последняя версия — v28: шаг 10min/hour/day/week/month, пояс p_tz)
-- ---------------------------------------------------------------------------------------

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
      where s.video_id = v.id
      order by (s.taken_at <= p_to) desc,
               case when s.taken_at <= p_to then s.taken_at end desc nulls last,
               s.taken_at asc
      limit 1
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
      where s.video_id = v.id
      order by (s.taken_at <= p_to) desc,
               case when s.taken_at <= p_to then s.taken_at end desc nulls last,
               s.taken_at asc
      limit 1
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

-- ---------------------------------------------------------------------------------------
-- 2. Итоги по креаторам (последняя версия — v23: один проход вместо двух десятков)
--
-- ⚠️ Правила v21/v22/v23 сохранены дословно:
--   • день/срок видео считается по published_at, а не по дате снимка;
--   • `p_only_ours` = `v.ours or v.watch` и действует на суммы И на счётчики видео;
--   • подписчики охвату не подчиняются (у аккаунта пометки «наше» нет);
--   • «начало» подписчиков — снимок не позже p_from, а нет такого — первый внутри срока;
--   • медиана прироста считается только по видео с приростом > 0, иначе null.
-- Меняется ровно один lateral — тот, что берёт снимок видео.
-- ---------------------------------------------------------------------------------------

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
    from public.creator_snaps s
    where s.taken_at <= p_to order by s.creator_id, s.taken_at desc
  ),
  fol_before as (
    select distinct on (s.creator_id) s.creator_id, s.followers
    from public.creator_snaps s
    where s.taken_at <= p_from order by s.creator_id, s.taken_at desc
  ),
  fol_first_inside as (
    select distinct on (s.creator_id) s.creator_id, s.followers
    from public.creator_snaps s
    where s.taken_at > p_from and s.taken_at <= p_to order by s.creator_id, s.taken_at asc
  ),
  -- Один проход по videos на оба счётчика: было по два коррелированных count(*) на креатора.
  counts as (
    select v.creator_id,
           count(*) as videos_total,
           count(*) filter (
             where v.published_at >= p_from and v.published_at <= p_to
           ) as videos_published
    from public.videos v
    where (not p_only_ours or v.ours or v.watch)
    group by v.creator_id
  ),
  -- И один проход на суммы: было по пять коррелированных sum(...) плюс медиана.
  per_video as (
    select
      v.creator_id,
      coalesce(f.views, 0) as views_delta,
      coalesce(f.likes, 0) as likes_delta,
      coalesce(f.comments, 0) as comments_delta,
      coalesce(f.shares, 0) as shares_delta,
      coalesce(f.saves, 0) as saves_delta
    from public.videos v
    left join lateral (
      select s.views, s.likes, s.comments, s.shares, s.saves from public.video_snaps s
      where s.video_id = v.id
      order by (s.taken_at <= p_to) desc,
               case when s.taken_at <= p_to then s.taken_at end desc nulls last,
               s.taken_at asc
      limit 1
    ) f on true
    where v.published_at >= p_from and v.published_at <= p_to
      and (not p_only_ours or v.ours or v.watch)
  ),
  agg as (
    select
      pv.creator_id,
      sum(pv.views_delta)    as views_delta,
      sum(pv.likes_delta)    as likes_delta,
      sum(pv.comments_delta) as comments_delta,
      sum(pv.shares_delta)   as shares_delta,
      sum(pv.saves_delta)    as saves_delta,
      percentile_cont(0.5) within group (order by pv.views_delta)
        filter (where pv.views_delta > 0) as median_views_delta
    from per_video pv
    group by pv.creator_id
  )
  select
    vis.id,
    fn.followers,
    case when fn.followers is null then null else fn.followers - coalesce(fb.followers, ff.followers) end,
    coalesce(cn.videos_total, 0),
    coalesce(cn.videos_published, 0),
    coalesce(ag.views_delta, 0),
    coalesce(ag.likes_delta, 0),
    coalesce(ag.comments_delta, 0),
    coalesce(ag.shares_delta, 0),
    coalesce(ag.saves_delta, 0),
    ag.median_views_delta
  from vis
  left join fol_now fn on fn.creator_id = vis.id
  left join fol_before fb on fb.creator_id = vis.id
  left join fol_first_inside ff on ff.creator_id = vis.id
  left join counts cn on cn.creator_id = vis.id
  left join agg ag on ag.creator_id = vis.id;
$$;

-- ---------------------------------------------------------------------------------------
-- 3. Строки видео в карточке креатора (последняя версия — v22)
--
-- Здесь была не только нулёвка, но и пропажа строк: CTE `finish` присоединялся ВНУТРЕННИМ
-- join, поэтому видео без снимка «не позже p_to» выпадало из ответа целиком. Теперь тот же
-- lateral с фолбэком; join оставлен внутренним НАМЕРЕННО — видео совсем без снимков не
-- приходило и раньше, и показывать о нём нечего.
-- ---------------------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------------------
-- 4. Видео за срок со свежим снимком (последняя версия — v23)
--
-- ⚠️ Видео без даты публикации не берём вовсе: у страницы срок, а положить их некуда.
-- ⚠️ В сортировке вторым ключом стоит `v.id`: PostgREST режет ответ на 1000 строках, и сайт
-- дочитывает остаток вторым запросом через Range. У видео, вышедших в одну и ту же секунду,
-- без второго ключа порядок от запроса к запросу свой — и на стыке страниц одна строка
-- приезжала бы дважды, а другая терялась.
-- ---------------------------------------------------------------------------------------

create or replace function public.videos_with_latest(
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

comment on function public.daily_views_all(timestamptz, timestamptz, text, boolean, text, text)
  is 'Ряд по часам/дням/неделям/месяцам в поясе p_tz: точка = счётчики роликов, вышедших в этот отрезок. Снимок — последний не позже p_to, а нет такого — самый ранний известный.';
comment on function public.creator_daily_views(uuid, timestamptz, timestamptz, boolean, text, text)
  is 'То же по одному креатору.';
comment on function public.creators_overview(timestamptz, timestamptz, boolean)
  is 'Итоги по креаторам за срок. Снимок видео — последний не позже p_to, а нет такого — самый ранний известный.';
comment on function public.video_stats_between(uuid, timestamptz, timestamptz, boolean)
  is 'Строки видео креатора. Снимок — последний не позже p_to, а нет такого — самый ранний известный.';
comment on function public.videos_with_latest(timestamptz, timestamptz, uuid, text, boolean, int)
  is 'Видео за срок со снимком: последний не позже p_to, а нет такого — самый ранний известный.';
