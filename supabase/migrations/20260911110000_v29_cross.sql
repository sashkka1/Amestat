-- v29 (владелец, 2026-09-11): перекрёстная проверка креаторов — страница «Amestat Test».
--
-- Владелец: «если один наш креатор комментирует/лайкает/смотрит видео другого нашего,
-- система это помечает. Например, у видео 5 комментариев, а рядом жёлтым (1) — один из них
-- от другого нашего креатора».
--
-- 🔴 Что сравнить МОЖНО и что нельзя — это про данные, а не про желание:
--   ✅ комментарии и ответы — `video_comments.author_handle` есть у каждой строки;
--   ✅ упоминания в подписи — `videos.caption` содержит «@имя»;
--   ❌ лайки, просмотры, подписки, сохранения — площадки отдают ТОЛЬКО числа, без имён.
--      Сопоставлять их не с чем, и страница говорит об этом прямой строкой, а не молчит.
--
-- Функция отдаёт по одной строке на видео, у которого есть что сказать: снятые тексты
-- комментариев или упоминание нашего в подписи. Видео без единого снятого текста и без
-- упоминаний не приходят вовсе — иначе за «Всё время» ответ упёрся бы в потолок PostgREST
-- в 1000 строк, а сказать о таком видео всё равно нечего (ноль и так ноль).
--
-- Что значит «перекрёстный»: автор комментария — наш креатор ТОЙ ЖЕ площадки, отличный от
-- владельца видео. Самокомментарий — автор и есть владелец видео; это не перекрёстность, и
-- смешивать их нельзя: свой комментарий под своим роликом дело обычное, чужой — событие.
-- Площадка учитывается потому, что @orandocom.lis в TikTok и в Instagram — разные люди.
--
-- Границы и охват — как у остальных статистических функций (v21, v22): видео отбираются по
-- ДАТЕ ПУБЛИКАЦИИ внутри срока, `p_only_ours` сужает набор до `ours or watch`. Тогда число
-- комментариев на странице и число перекрёстных рядом с ним считаны по одному набору видео.
--
-- ⚠️ `p_tz` принимается ради одинаковой формы вызова с `daily_views_all` и на отбор не
-- влияет: границы срока — моменты времени, а не местные сутки, и пояс их не двигает. Резать
-- ряд по отрезкам здесь нечего — строка привязана к видео, а не ко времени.
--
-- ⚠️ `comments_total` — это сколько текстов СНЯТО у видео (корневые вместе с ответами), а не
-- счётчик площадки из `video_snaps.comments`. Они расходятся: сборщик берёт до N комментариев
-- и до 20 ответов на ветку, а у не наших видео тексты обычно не снимает вовсе. Доля
-- перекрёстных честна только к снятому, и страница показывает её рядом со своим же итогом.

create or replace function public.cross_stats(
  p_from timestamptz,
  p_to timestamptz,
  p_platform text default null,
  p_only_ours boolean default false,
  p_tz text default 'UTC'
)
returns table (
  video_id       text,
  creator_id     uuid,
  comments_total bigint,
  comments_cross bigint,
  comments_self  bigint,
  -- По одной записи на каждый перекрёстный комментарий: повторы нарочно. Отсюда страница
  -- берёт и подсказку «N комментариев от @a, @b» (по различным именам), и матрицу «кто кого
  -- комментировал» (по числу повторов). Двух колонок ради этого не нужно.
  cross_authors  text[],
  mentions_cross text[]
)
language sql
stable
security invoker
set search_path = ''
as $$
  with ours as (
    -- Наши креаторы, видимые вошедшему: RLS на creators сама оставит нужных (у менеджера —
    -- только его). Имя сравнивается в нижнем регистре: площадки регистр не держат.
    select c.id, c.platform, c.handle, lower(c.handle) as h
    from public.creators c
  ),
  vids as (
    select v.id, v.creator_id, v.caption, o.platform
    from public.videos v
    join ours o on o.id = v.creator_id
      and (p_platform is null or o.platform = p_platform)
    where v.published_at >= p_from and v.published_at <= p_to
      and (not p_only_ours or v.ours or v.watch)
  ),
  cmt as (
    select
      vv.id as video_id,
      count(*) as total,
      count(*) filter (where a.id is not null and a.id <> vv.creator_id) as cross_n,
      count(*) filter (where a.id is not null and a.id =  vv.creator_id) as self_n,
      coalesce(
        array_agg(a.handle order by a.handle)
          filter (where a.id is not null and a.id <> vv.creator_id),
        '{}'
      ) as authors
    from vids vv
    join public.video_comments k on k.video_id = vv.id
    -- Ответы считаются наравне с корневыми: ответ нашего креатора под чужим роликом — та же
    -- перекрёстность. '@' сборщик не пишет, но ведущий символ снимаем на случай другой ленты.
    left join ours a
      on a.platform = vv.platform
     and a.h = lower(ltrim(k.author_handle, '@'))
    group by vv.id
  ),
  men as (
    -- Упоминания в подписи: «@имя» из caption, оставляем только наших и не самого автора.
    -- Набор символов тот же, что у разбора имени на сайте (`src/lib/handle.ts`).
    select vv.id as video_id, array_agg(distinct a.handle) as handles
    from vids vv
    cross join lateral regexp_matches(coalesce(vv.caption, ''), '@([A-Za-z0-9._]+)', 'g') as m(parts)
    join ours a
      on a.platform = vv.platform
     and a.h = lower(m.parts[1])
     and a.id <> vv.creator_id
    group by vv.id
  )
  select
    vv.id,
    vv.creator_id,
    coalesce(c.total, 0)::bigint,
    coalesce(c.cross_n, 0)::bigint,
    coalesce(c.self_n, 0)::bigint,
    coalesce(c.authors, '{}')::text[],
    coalesce(m.handles, '{}')::text[]
  from vids vv
  left join cmt c on c.video_id = vv.id
  left join men m on m.video_id = vv.id
  where c.video_id is not null or m.video_id is not null;
$$;

-- Гостю без входа она ни к чему, как и остальные статистические функции.
revoke execute on function public.cross_stats(timestamptz, timestamptz, text, boolean, text) from anon;

comment on function public.cross_stats(timestamptz, timestamptz, text, boolean, text)
  is 'Перекрёстность по видео: комментарии от других наших креаторов, самокомментарии и упоминания наших в подписи. Лайки/просмотры/подписки площадки без имён не отдают.';
