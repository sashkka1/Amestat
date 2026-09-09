-- v14: ход обхода, видимый с сайта. Владелец, 2026-09-09: «нужно больше информативности —
-- что за обход, сколько выполнено, на сколько ещё». Раньше `creators_done`/`creators_failed`
-- писались один раз в конце; теперь сборщик обновляет их после каждого креатора и держит
-- рядом общее число и того, кого собирает сейчас (по полосе на площадку — их может быть двое).

alter table public.sync_runs
  add column creators_total integer,
  add column current_handles text[] not null default '{}',
  add column progress_at timestamptz;

comment on column public.sync_runs.creators_total is 'Сколько креаторов в этом обходе всего; null — обход ещё не отобрал список.';
comment on column public.sync_runs.current_handles is 'Кого собираем прямо сейчас (по одному на полосу TikTok/Instagram).';
comment on column public.sync_runs.progress_at is 'Когда последний раз двигались счётчики done/failed.';
