-- «Наше / не наше» (владелец, 2026-09-07): у креатора бывают видео, которые считать не надо.
--
-- - `creators.all_videos_ours` — галочка «все видео наши»: новые видео этого креатора
--   считаются в статистике; включение галочки на сайте делает нашими и все уже собранные.
-- - `videos.ours` — само решение по видео. Новой строке его ставит триггер по галочке
--   креатора; дальше меняет только владелец на сайте. Сборщик поле не трогает.
-- - Статистика за срок и график считают только `ours = true`; таблица видео на сайте
--   показывает все, с переключателем.

alter table public.creators
  add column all_videos_ours boolean not null default true;

alter table public.videos
  add column ours boolean;

create function public.videos_default_ours()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.ours is null then
    select c.all_videos_ours into new.ours
    from public.creators c
    where c.id = new.creator_id;
    new.ours := coalesce(new.ours, true);
  end if;
  return new;
end;
$$;

create trigger videos_default_ours
  before insert on public.videos
  for each row execute function public.videos_default_ours();

-- BEFORE-триггер отрабатывает до проверки NOT NULL, поэтому ограничение безопасно.
alter table public.videos alter column ours set not null;

create index videos_creator_ours_idx on public.videos (creator_id) where ours;

-- Владелец переключает «наше» на сайте. UPDATE требует и SELECT-политики — она уже есть.
create policy "owner marks videos" on public.videos for update to authenticated using (true) with check (true);

-- Статистика: те же функции, но в выдаче есть `ours`, а суммы и медианы сайт считает
-- только по нашим. График — только по нашим.
drop function public.video_stats_between(uuid, timestamptz, timestamptz);

create function public.video_stats_between(p_creator uuid, p_from timestamptz, p_to timestamptz)
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
  ),
  before as (
    select distinct on (s.video_id) s.video_id, s.views, s.likes, s.comments, s.shares, s.saves
    from public.video_snaps s
    join vids on vids.id = s.video_id
    where s.taken_at <= p_from
    order by s.video_id, s.taken_at desc
  ),
  first_inside as (
    select distinct on (s.video_id) s.video_id, s.views, s.likes, s.comments, s.shares, s.saves
    from public.video_snaps s
    join vids on vids.id = s.video_id
    where s.taken_at > p_from and s.taken_at <= p_to
    order by s.video_id, s.taken_at asc
  ),
  start as (
    select
      vids.id as video_id,
      coalesce(b.views,    case when vids.published_at >= p_from then 0 else fi.views    end, 0) as views,
      coalesce(b.likes,    case when vids.published_at >= p_from then 0 else fi.likes    end, 0) as likes,
      coalesce(b.comments, case when vids.published_at >= p_from then 0 else fi.comments end, 0) as comments,
      coalesce(b.shares,   case when vids.published_at >= p_from then 0 else fi.shares   end, 0) as shares,
      coalesce(b.saves,    case when vids.published_at >= p_from then 0 else fi.saves    end, 0) as saves
    from vids
    left join before b on b.video_id = vids.id
    left join first_inside fi on fi.video_id = vids.id
  )
  select
    vids.id, vids.published_at, vids.caption, vids.cover_url, vids.url, vids.ours,
    f.views, f.likes, f.comments, f.shares, f.saves,
    greatest(coalesce(f.views, 0)    - st.views,    0),
    greatest(coalesce(f.likes, 0)    - st.likes,    0),
    greatest(coalesce(f.comments, 0) - st.comments, 0),
    greatest(coalesce(f.shares, 0)   - st.shares,   0),
    greatest(coalesce(f.saves, 0)    - st.saves,    0)
  from vids
  join finish f on f.video_id = vids.id
  join start st on st.video_id = vids.id
  order by vids.published_at desc nulls last;
$$;

create or replace function public.creator_daily_views(p_creator uuid, p_from timestamptz, p_to timestamptz)
returns table (day date, views bigint, likes bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with days as (
    select generate_series(date_trunc('day', p_from), date_trunc('day', p_to), interval '1 day')::date as day
  ),
  per_video_day as (
    select distinct on (d.day, s.video_id) d.day, s.video_id, s.views, s.likes
    from days d
    join public.videos v on v.creator_id = p_creator and v.ours
    join public.video_snaps s on s.video_id = v.id and s.taken_at < (d.day + 1)::timestamptz
    order by d.day, s.video_id, s.taken_at desc
  )
  select d.day, coalesce(sum(p.views), 0)::bigint, coalesce(sum(p.likes), 0)::bigint
  from days d
  left join per_video_day p on p.day = d.day
  group by d.day
  order by d.day;
$$;

revoke execute on function public.video_stats_between(uuid, timestamptz, timestamptz) from anon;
revoke execute on function public.creator_daily_views(uuid, timestamptz, timestamptz) from anon;
