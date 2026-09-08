-- Версия 12 (2026-09-08, вечер): что снимать при обновлении и «комментарии не менялись».
--
-- Владелец: в матрице обновления два пункта — «снимать комментарии» и «снимать ветки ответов»
-- (обход по расписанию снимает и то и другое); «если число комментариев такое же, как в прошлый
-- раз, — не снимать их заново».

alter table public.sync_requests
  add column comments boolean not null default true,   -- снимать тексты комментариев
  add column replies  boolean not null default true;   -- и ветки ответов под ними

alter table public.sync_runs
  add column comments boolean not null default true,
  add column replies  boolean not null default true;

comment on column public.sync_requests.comments is 'Снимать ли тексты комментариев у свежих видео; false — только счётчики.';
comment on column public.sync_requests.replies  is 'Раскрывать ли ветки ответов под комментариями; без comments смысла не имеет.';

-- При каком числе комментариев (из снимка) тексты снимались последний раз: не изменилось —
-- сборщик видео пропускает, и повторный обход не тратит минуты на то же самое.
alter table public.videos add column comments_synced_count integer;

comment on column public.videos.comments_synced_count is 'Число комментариев в снимке на момент последнего съёма текстов; сборщик пропускает видео, если оно не изменилось.';
