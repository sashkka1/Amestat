-- Версия 6 (2026-09-08): кнопка «Обновить» на сайте для локального сборщика.
--
-- Владелец: TikTok собирается дома (сборщик `collector/` на установленной Opera), поэтому
-- мост «сайт → сборщик» возвращается: сайт вставляет просьбу, сборщик слушает вставки через
-- Realtime, ставит `taken_at`, когда забрал, и `run_id` — обход, который её выполнил.
-- Таблица была в init и удалена в v2 (тогда ждали облачный обход); здесь — с ролями.

create table public.sync_requests (
  id           bigint generated always as identity primary key,
  requested_at timestamptz not null default now(),
  requested_by uuid not null references auth.users (id) on delete cascade,
  creator_id   uuid references public.creators (id) on delete cascade, -- null — обойти всех
  taken_at     timestamptz,
  run_id       bigint references public.sync_runs (id) on delete set null
);

comment on table public.sync_requests is 'Просьбы «обновить» с сайта. Пишет сайт (insert), забирает сборщик (service_role).';

create index sync_requests_open_idx on public.sync_requests (requested_at) where taken_at is null;

alter table public.sync_requests enable row level security;

-- Просить может любой вошедший с ролью: за всех или за креатора, которого видит.
create policy "members request sync" on public.sync_requests
  for insert to authenticated
  with check (
    (select public.current_role_name()) is not null
    and requested_by = (select auth.uid())
    and (creator_id is null or public.can_see_creator(creator_id))
  );

-- Строка просьбы чужих данных не содержит — видят все вошедшие с ролью (нужно, чтобы
-- кнопка на сайте видела, что просьба уже в очереди или взята).
create policy "members see sync_requests" on public.sync_requests
  for select to authenticated
  using ((select public.current_role_name()) is not null);

alter table public.sync_requests replica identity full;
alter publication supabase_realtime add table public.sync_requests;
