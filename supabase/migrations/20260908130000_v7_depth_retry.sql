-- Версия 7 (2026-09-08): глубина обновления и повтор после неудачи.
--
-- Владелец: при ручном обновлении с сайта человек выбирает матрицей, что обновить —
-- «все креаторы» или «эта страница» × «всё» или «только последняя неделя»; по расписанию
-- три раза в день обновляется всё, при неудаче повтор через час, при второй неудаче —
-- сообщение владельцу в Telegram.
--
-- Что меняется в базе: у просьбы и у обхода появляется `depth` ('all' — весь список видео,
-- 'week' — только видео за последние 7 дней), у обхода — новый повод `retry`.

alter table public.sync_requests
  add column depth text not null default 'all' check (depth in ('all', 'week'));

alter table public.sync_runs
  add column depth text not null default 'all' check (depth in ('all', 'week'));

alter table public.sync_runs drop constraint sync_runs_trigger_check;
alter table public.sync_runs
  add constraint sync_runs_trigger_check check (trigger in ('schedule', 'catchup', 'manual', 'retry'));

comment on column public.sync_requests.depth is 'all — весь список видео креатора; week — только видео за последние 7 дней (быстрее, меньше запросов к площадке).';
comment on column public.sync_runs.depth is 'Глубина обхода: all или week, см. sync_requests.depth.';
comment on column public.sync_runs.trigger is 'schedule — слот расписания; catchup — догон пропущенного слота; manual — кнопка с сайта или запуск руками; retry — повтор через час после неудачного обхода по расписанию.';
