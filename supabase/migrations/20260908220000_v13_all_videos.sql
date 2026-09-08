-- v13: комментарии снимаются только у НАШИХ видео (`videos.ours`), у остальных — лишь счётчики
-- из списка площадки (просмотры, лайки, число комментариев, дата — они приходят даром).
-- Владелец, 2026-09-08: «эту информацию собирать вообще по всем видосам, а по нашим уже всю
-- остальную»; и следом: «чтобы можно было запросить абсолютно всю информацию — тоже в матрицу».
-- Отсюда флаг `all_videos`: просьба с ним снимает тексты комментариев и у не наших видео.
-- Расписание его не ставит никогда.

alter table public.sync_requests
  add column all_videos boolean not null default false;
alter table public.sync_runs
  add column all_videos boolean not null default false;

comment on column public.sync_requests.all_videos is 'Снимать комментарии и у не наших видео (обычно — только у наших).';
comment on column public.sync_runs.all_videos is 'С каким флагом all_videos шёл обход.';
