-- Версия 38 (владелец, 2026-09-19): окно расчёта закрывается вовремя, а не следующим обходом.
--
-- Зачем. Обход ходит два раза в сутки, поэтому отметка «публикация + окно» почти никогда не
-- совпадает со снимком: по живым данным ни одно видео не легло ровно в 72 часа — 74, 75, 76,
-- 78, а одно и вовсе 90 (ночная отметка, ноутбук был выключен). Считается при этом первый
-- снимок на отметке или после неё, значит эти лишние часы просмотров попадают в выплату.
-- Владелец, 2026-09-19: «сделай так, чтобы в момент, когда окно закрывается, конкретно это
-- видео обновлялось».
--
-- Как. Резидент сборщика раз в несколько минут спрашивает функцию ниже: у кого только что
-- закрылось окно и снимка после отметки ещё нет. Такие креаторы обходятся сразу — коротким
-- обходом без комментариев. Расписание, кнопка и повторы работают как работали.
--
-- ⚠️ Сборщик про таблицы оплаты по-прежнему ничего не знает: он видит одну эту функцию, а не
-- `payment_rules` с `payment_videos`.

-- Обход, вызванный закрытием окна, помечается своим поводом: иначе он смешался бы с ручными
-- просьбами владельца в журнале обходов.
alter table public.sync_runs drop constraint sync_runs_trigger_check;
alter table public.sync_runs
  add constraint sync_runs_trigger_check
  check (trigger in ('schedule', 'catchup', 'manual', 'retry', 'window'));

-- ---------------------------------------------------------------------------------------
-- Кому пора закрывать окно
-- ---------------------------------------------------------------------------------------
--
-- Отдаются наши видео, у которых:
--   отметка окна уже прошла, но не раньше чем `p_max_age_hours` назад (древние догонит
--     обычный обход — гнаться за ними отдельным заходом смысла нет);
--   был снимок ВНУТРИ окна — иначе считать всё равно нечего и обновлять незачем;
--   ещё нет снимка на отметке или позже — то есть окно действительно открыто.
-- Архивные, поставленные на паузу и удалённые с площадки пропускаются: обходить их нельзя
-- или незачем.

create function public.payment_window_due(p_max_age_hours int default 24)
returns table (
  creator_id uuid,
  handle     text,
  platform   text,
  video_id   text,
  mark_at    timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with vids as (
    select
      c.id as creator_id, c.handle, c.platform, v.id as video_id,
      v.published_at + make_interval(hours => r.window_hours) as mark_at
    from public.videos v
    join public.creators c on c.id = v.creator_id
    join public.payment_rules r on r.creator_id = v.creator_id
    where v.published_at is not null
      and (v.ours or v.watch)
      and v.gone_at is null
      and c.archived_at is null
      and not c.sync_off
  )
  select vids.creator_id, vids.handle, vids.platform, vids.video_id, vids.mark_at
  from vids
  where vids.mark_at <= now()
    and vids.mark_at >= now() - make_interval(hours => greatest(p_max_age_hours, 0))
    and exists (
      select 1 from public.video_snaps s
      where s.video_id = vids.video_id and s.taken_at <= vids.mark_at
    )
    and not exists (
      select 1 from public.video_snaps s
      where s.video_id = vids.video_id and s.taken_at >= vids.mark_at
    )
  order by vids.mark_at asc;
$$;

comment on function public.payment_window_due(int)
  is 'Наши видео, у которых окно расчёта только что закрылось, а снимка после отметки ещё нет. Спрашивает резидент сборщика (v38).';

revoke execute on function public.payment_window_due(int) from public, anon;
grant execute on function public.payment_window_due(int) to authenticated, service_role;
