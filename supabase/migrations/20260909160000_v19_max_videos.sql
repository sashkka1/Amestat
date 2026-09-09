-- v19: потолок числа видео на креатора в обходе.
-- Владелец, 2026-09-09: у креатора с 500 видео и без свежих публикаций «неделя» ничего не
-- даёт, а «всё» листает всю историю и падает; нужен выбор «20 / 50 / 100 / все» видео на
-- креатора поверх глубины по времени. null — без потолка (как всегда). Расписание ходит без
-- потолка.

alter table public.sync_requests
  add column max_videos integer check (max_videos is null or max_videos > 0);
alter table public.sync_runs
  add column max_videos integer check (max_videos is null or max_videos > 0);

comment on column public.sync_requests.max_videos is 'Не больше стольких видео (самых новых в пределах глубины) на креатора; null — без потолка.';
comment on column public.sync_runs.max_videos is 'С каким потолком видео на креатора шёл обход; null — без потолка.';
