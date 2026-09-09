-- v18: глубина обхода «месяц» и «выбранный период».
-- Владелец, 2026-09-09: «в матрице есть 7 дней и всё время — сделаем ещё за месяц и за
-- выбранный период». Глубина 'month' — видео за последние 30 дней; 'range' — видео,
-- опубликованные между depth_from и depth_to (обе границы обязательны у 'range', у остальных
-- глубин пусты). Список площадки идёт от новых к старым, поэтому сборщик листает до первого
-- видео старше нижней границы, а видео новее верхней просто не кладёт.

alter table public.sync_requests
  drop constraint if exists sync_requests_depth_check,
  add constraint sync_requests_depth_check check (depth in ('all', 'week', 'month', 'range')),
  add column depth_from timestamptz,
  add column depth_to   timestamptz,
  add constraint sync_requests_range_check
    check (depth <> 'range' or (depth_from is not null and depth_to is not null and depth_from < depth_to));

alter table public.sync_runs
  drop constraint if exists sync_runs_depth_check,
  add constraint sync_runs_depth_check check (depth in ('all', 'week', 'month', 'range')),
  add column depth_from timestamptz,
  add column depth_to   timestamptz;

comment on column public.sync_requests.depth_from is 'Нижняя граница периода у depth = range (включительно).';
comment on column public.sync_requests.depth_to   is 'Верхняя граница периода у depth = range (включительно).';
