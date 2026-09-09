-- v23 (владелец, 2026-09-09): «страницы долго подгружаются — сделать что-то с оптимизацией».
--
-- ═══ Что именно тормозило ═══
--
-- Данных в базе мало (10 креаторов, 1234 видео, 2760 снимков) — и всё равно дашборд собирался
-- ~9,5 с. EXPLAIN (ANALYZE, BUFFERS) под учёткой сайта показал, что время съедала не выборка,
-- а RLS:
--
--   Seq Scan on videos (actual rows=1234)
--     Filter: (SubPlan 1)
--     SubPlan 1 -> Result (actual time=0.293 loops=1234)   ← 361 мс из 369 мс запроса
--
-- Политики были написаны в «правильной» форме `using ((select public.can_see_creator(...)))`.
-- Но приём `(select fn())` спасает только от ПОВТОРНОГО вызова функции без аргументов:
-- Postgres поднимает такой подзапрос в InitPlan и считает один раз. `can_see_creator(creator_id)`
-- берёт колонку строки, значит подзапрос КОРРЕЛИРОВАННЫЙ — поднять его нельзя, и функция
-- зовётся на каждую строку. Внутри неё ещё один запрос к profiles: 1234 обращения к базе
-- ради одного «да, админ».
--
-- Где это било сильнее всего:
--   • `select * from videos` (1000 строк)                  369 мс — почти весь RLS
--   • `video_latest where video_id in (200)`               802 мс — политика video_snaps
--     разворачивалась в проход по ВСЕЙ таблице videos с той же функцией на каждой строке,
--     и сайт звал этот запрос шесть раз подряд → ~6 с на одном месте
--   • `creators_overview`                                  449 мс
--
-- ═══ Что сделано ═══
--
-- 1. Политики переписаны в НЕкоррелированную форму:
--        (select public.is_admin()) or creator_id in (select cm.creator_id from creator_managers cm ...)
--    Обе половины от строки не зависят: первая становится InitPlan, вторая — хешированным
--    подпланом, который строится один раз на запрос. У админа первая половина истинна, и
--    вторая не выполняется вовсе.
--    ⚠️ Смысл политик не меняется ни на йоту: это дословно тело `can_see_creator`,
--    развёрнутое в предикат. Сама функция остаётся — её зовут места, где строка одна
--    (вставка просьбы об обходе, привязка тега).
--
-- 2. `creators_overview` считается одним проходом. Было: два коррелированных `count(*)`
--    и пять коррелированных `sum(...)` на каждого креатора — 10 креаторов давали 20+ проходов
--    по videos, и каждый со своим RLS. Стало: `group by creator_id` в двух CTE. Семантика
--    v21/v22 сохранена дословно (атрибуция по дате публикации, `p_only_ours`, медиана только
--    по положительным приростам).
--
-- 3. Новая функция `videos_with_latest` — видео за срок вместе со свежим снимком, одним
--    запросом. Раньше дашборд читал видео страницами по 1000, а потом добирал счётчики
--    шестью запросами к `video_latest` по 200 id: семь обращений к сети вместо одного.
--
-- 4. Индекс `videos (published_at desc)` — дашборд сортирует и режет по этой колонке по всем
--    креаторам сразу, а был только составной `(creator_id, published_at desc)`.

-- ---------------------------------------------------------------------------------------
-- 1. RLS: тот же смысл, но без вызова функции на каждую строку
-- ---------------------------------------------------------------------------------------

drop policy "sees visible creators" on public.creators;
create policy "sees visible creators" on public.creators for select to authenticated
  using (
    (select public.is_admin())
    or id in (select cm.creator_id from public.creator_managers cm where cm.manager_id = (select auth.uid()))
  );

drop policy "sees visible videos" on public.videos;
create policy "sees visible videos" on public.videos for select to authenticated
  using (
    (select public.is_admin())
    or creator_id in (select cm.creator_id from public.creator_managers cm where cm.manager_id = (select auth.uid()))
  );

drop policy "marks visible videos" on public.videos;
create policy "marks visible videos" on public.videos for update to authenticated
  using (
    (select public.is_admin())
    or creator_id in (select cm.creator_id from public.creator_managers cm where cm.manager_id = (select auth.uid()))
  )
  with check (
    (select public.is_admin())
    or creator_id in (select cm.creator_id from public.creator_managers cm where cm.manager_id = (select auth.uid()))
  );

drop policy "sees visible snaps" on public.creator_snaps;
create policy "sees visible snaps" on public.creator_snaps for select to authenticated
  using (
    (select public.is_admin())
    or creator_id in (select cm.creator_id from public.creator_managers cm where cm.manager_id = (select auth.uid()))
  );

-- Снимки видео: раньше здесь стоял `exists (... videos v ... can_see_creator(v.creator_id))`,
-- и на каждую строку снимков разворачивался проход по videos.
drop policy "sees visible video_snaps" on public.video_snaps;
create policy "sees visible video_snaps" on public.video_snaps for select to authenticated
  using (
    (select public.is_admin())
    or video_id in (
      select v.id from public.videos v
      join public.creator_managers cm on cm.creator_id = v.creator_id
      where cm.manager_id = (select auth.uid())
    )
  );

drop policy "sees visible comments" on public.video_comments;
create policy "sees visible comments" on public.video_comments for select to authenticated
  using (
    (select public.is_admin())
    or video_id in (
      select v.id from public.videos v
      join public.creator_managers cm on cm.creator_id = v.creator_id
      where cm.manager_id = (select auth.uid())
    )
  );

-- ---------------------------------------------------------------------------------------
-- 2. Индексы
-- ---------------------------------------------------------------------------------------

-- Дашборд берёт видео всех креаторов сразу: и срок, и сортировка идут по published_at.
create index if not exists videos_published_idx on public.videos (published_at desc);

-- ---------------------------------------------------------------------------------------
-- 3. Видео за срок со свежим снимком — одним запросом
--
-- ⚠️ Снимок берётся ПОСЛЕДНИЙ вообще, без оглядки на p_to, — ровно как отдавал вид
-- `video_latest`, который эта функция заменяет на страницах. Числа в таблице «Новые видео»
-- и в карточках «Лучших видео» остаются теми же, что были.
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
    order by s.taken_at desc
    limit 1
  ) s on true
  where v.published_at >= p_from and v.published_at <= p_to
    and (p_creator is null or v.creator_id = p_creator)
    and (not p_only_ours or v.ours or v.watch)
  order by v.published_at desc, v.id desc
  limit greatest(p_limit, 0);
$$;

revoke execute on function public.videos_with_latest(timestamptz, timestamptz, uuid, text, boolean, int) from anon;

-- ---------------------------------------------------------------------------------------
-- 4. creators_overview — один проход вместо двух десятков
--
-- ⚠️ Правила v21/v22 сохранены дословно:
--   • день/срок видео считается по published_at, а не по дате снимка;
--   • `p_only_ours` = `v.ours or v.watch` и действует на суммы И на счётчики видео;
--   • подписчики охвату не подчиняются (у аккаунта пометки «наше» нет);
--   • «начало» подписчиков — снимок не позже p_from, а нет такого — первый внутри срока;
--   • медиана прироста считается только по видео с приростом > 0, иначе null.
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
      where s.video_id = v.id and s.taken_at <= p_to order by s.taken_at desc limit 1
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

revoke execute on function public.creators_overview(timestamptz, timestamptz, boolean) from anon;

-- `video_stats_between`, `daily_views_all` и `creator_daily_views` не тронуты: после правки
-- политик их планы укладываются в единицы миллисекунд (10 / 5 / 4 мс на EXPLAIN ANALYZE),
-- переписывать там нечего.
