-- v17: три состояния видео и охват ручного обхода.
-- Владелец, 2026-09-09: «у видео должно быть три состояния: не наше; наше (зелёное); не наше,
-- но хотим смотреть его историю (жёлтое). При обновлении по просьбе — выбор „всё" или „только
-- наши", тогда лишние видео не смотрим и экономим время; ежедневный обход обновляет всё».
--
-- Состояние видео = ours ? 'ours' : watch ? 'watch' : 'none'. `ours` остаётся как было
-- (триггер по умолчанию от галочки креатора), `watch` имеет смысл только при ours = false.
-- Что даёт состояние сборщику: 'ours' — счётчики и тексты комментариев; 'watch' — только
-- счётчики (история просмотров); 'none' — строка в списке и счётчики, если пришли даром.

alter table public.videos
  add column watch boolean not null default false;

create index videos_creator_tracked_idx on public.videos (creator_id) where ours or watch;

-- Охват ручного обхода: 'all' — весь список, как всегда; 'ours' — список листается лишь до
-- тех пор, пока не встретились все наши и жёлтые видео креатора (новые по пути всё равно
-- заводятся), тексты комментариев — только у наших. Расписание всегда ходит с 'all'.
alter table public.sync_requests
  add column videos text not null default 'all' check (videos in ('all', 'ours'));
alter table public.sync_runs
  add column videos text not null default 'all' check (videos in ('all', 'ours'));

comment on column public.videos.watch is 'Жёлтое: не наше, но следим за историей счётчиков; при ours = true не важно.';
comment on column public.sync_requests.videos is 'Охват обхода: all — весь список; ours — только наши и жёлтые видео.';
comment on column public.sync_runs.videos is 'С каким охватом видео шёл обход.';
