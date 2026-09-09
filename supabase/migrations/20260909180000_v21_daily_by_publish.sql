-- v21 (владелец, 2026-09-09): ВСЯ статистика за срок относится к ДАТЕ ПУБЛИКАЦИИ видео.
--
-- Владелец: «график динамики за 9 сентября должен показывать статистику только за 9 сентября:
-- у npodcast123 за 9-е одно видео на 460 просмотров, а график даёт 530 000». И следом,
-- о причине этого целиком: «все графики должны работать по дню публикации, вне зависимости
-- от того, в какой день сборщик что-то словил; я могу неделю не запускать сборщик — и тогда
-- весь контент как будто вышел в один день, это бред».
--
-- Что было (v20 и раньше): и дневные ряды, и итоги за срок считались ПРИРОСТОМ между
-- снимками, а видео, вышедшему внутри срока, приписывалась базовая линия 0. Значит вся
-- история такого ролика падала в тот день, когда сборщик впервые до него дошёл: пропустили
-- неделю — неделя контента слиплась в один столбец.
--
-- Что стало — одно правило на все четыре функции, и день снимка в нём не участвует вовсе:
--   значение = сумма ТЕКУЩИХ счётчиков (последний снимок с `taken_at <= p_to`) тех видео,
--   что опубликованы в этот день (дневные ряды) или внутри срока (итоги за срок).
--
-- Отсюда сходимость, которой раньше не было: сумма графика за срок = плитка сводки за тот же
-- срок — это одни и те же видео, разложенные по дням и посчитанные целиком. Границы отбора
-- видео у всех четырёх функций буквально одни (`published_at >= p_from and <= p_to`), поэтому
-- совпадение не «примерно», а точное.
--
-- ⚠️ Плата: «прирост за вчера» из базы больше не спросить — снимки для этого по-прежнему
-- есть, но ни одна функция их так не складывает. Владелец на это пошёл сознательно: число,
-- зависящее от дня запуска сборщика, ему не нужно ни в каком виде.
--
-- Сигнатуры и наборы колонок прежние: security invoker, set search_path = '', фильтр
-- площадки у `daily_views_all` на месте.

-- ⚠️ Первая редакция этой миграции заводила отдельную пару функций под переключатель
-- «по дате публикации / по дате просмотра». Переключателя нет — режим один, — и пара
-- убирается, чтобы в базе не осталось функции, которую никто не зовёт.
drop function if exists public.daily_by_publish_all(timestamptz, timestamptz, text);
drop function if exists public.creator_daily_by_publish(uuid, timestamptz, timestamptz);

-- 1. Дневные ряды: день = что набрали ролики, вышедшие в этот день.

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
  -- Границы отбора — те же, что у creators_overview и video_stats_between: иначе сумма
  -- графика перестала бы сходиться с плиткой на краях срока.
  -- ⚠️ День публикации считается date_trunc в часовом поясе базы — тем же, что и сетка дней
  -- выше, поэтому каждое видео обязательно попадает в один из дней сетки.
  vids as (
    select v.id, date_trunc('day', v.published_at)::date as day
    from public.videos v
    join public.creators c on c.id = v.creator_id   -- RLS оставит видимых
      and (p_platform is null or c.platform = p_platform)
    where v.published_at >= p_from and v.published_at <= p_to
  ),
  -- Текущие счётчики: последний снимок видео на конец срока. Снимка нет вовсе (видео нашли,
  -- но ещё не снимали) — нули, а не пропуск дня.
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
    select v.id, date_trunc('day', v.published_at)::date as day
    from public.videos v
    where v.creator_id = p_creator
      and v.published_at >= p_from and v.published_at <= p_to
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

-- 2. Итоги за срок — то же правило, чтобы плитка была суммой графика.
--
-- Отличие от v15: `per_video` берёт только видео, опубликованные ВНУТРИ срока, а вместо
-- разности снимков ставит текущие счётчики. Подписчики остаются по снимкам: у аккаунта
-- никакой «даты публикации» нет, и приписать его рост нечему.
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
  -- Видео, вышедшие в срок, с их текущими счётчиками. Ролик, опубликованный раньше, в срок
  -- не входит вовсе — сколько бы он за эти дни ни набрал.
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
    left join lateral (
      select s.views, s.likes, s.comments, s.shares, s.saves from public.video_snaps s
      where s.video_id = v.id and s.taken_at <= p_to order by s.taken_at desc limit 1
    ) f on true
  )
  select
    vis.id,
    fn.followers,
    case when fn.followers is null then null else fn.followers - coalesce(fb.followers, ff.followers) end,
    (select count(*) from public.videos v where v.creator_id = vis.id),
    (select count(*) from public.videos v where v.creator_id = vis.id and v.published_at >= p_from and v.published_at <= p_to),
    coalesce((select sum(pv.views_delta)    from per_video pv where pv.creator_id = vis.id), 0),
    coalesce((select sum(pv.likes_delta)    from per_video pv where pv.creator_id = vis.id), 0),
    coalesce((select sum(pv.comments_delta) from per_video pv where pv.creator_id = vis.id), 0),
    coalesce((select sum(pv.shares_delta)   from per_video pv where pv.creator_id = vis.id), 0),
    coalesce((select sum(pv.saves_delta)    from per_video pv where pv.creator_id = vis.id), 0),
    -- Медиана — по тем же видео. Нулевые (ещё не снятые) в неё не идут, как и раньше: иначе
    -- один ненайденный ролик уводил бы медиану в пол.
    (select percentile_cont(0.5) within group (order by pv.views_delta) from per_video pv where pv.creator_id = vis.id and pv.views_delta > 0)
  from vis
  left join fol_now fn on fn.creator_id = vis.id
  left join fol_before fb on fb.creator_id = vis.id
  left join fol_first_inside ff on ff.creator_id = vis.id;
$$;

-- Строки видео в карточке креатора. Колонки те же; `*_now` — как были, текущие счётчики,
-- а `*_delta` теперь означает «вклад видео в срок»: его текущие счётчики, если оно вышло
-- внутри срока, и 0, если раньше. Сумма `*_delta` по строкам = плитка = сумма графика.
create or replace function public.video_stats_between(p_creator uuid, p_from timestamptz, p_to timestamptz)
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

-- create or replace права сохраняет, но повторяем явно — чтобы правило было видно в файле.
revoke execute on function public.daily_views_all(timestamptz, timestamptz, text) from anon;
revoke execute on function public.creator_daily_views(uuid, timestamptz, timestamptz) from anon;
revoke execute on function public.creators_overview(timestamptz, timestamptz) from anon;
revoke execute on function public.video_stats_between(uuid, timestamptz, timestamptz) from anon;
