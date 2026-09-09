-- v16: журнал обхода для администратора и учёт провайдеров данных.
-- Владелец, 2026-09-09: данные TikTok/Instagram берутся у провайдеров (EnsembleData, Apify) по
-- четырём аккаунтам с чередованием, браузерный сборщик — запасной путь; на сайте админу нужен
-- живой ход обновления: «на каком аккаунте, сколько потратилось, сколько осталось». Менеджерам
-- этого не видно.

create table public.sync_log (
  id             bigint generated always as identity primary key,
  run_id         bigint references public.sync_runs(id) on delete cascade,
  at             timestamptz not null default now(),
  level          text not null default 'info' check (level in ('info', 'warn', 'error')),
  -- Откуда пришли данные строки: ensembledata | apify | browser | system.
  source         text not null default 'system',
  -- Метка аккаунта провайдера: «ED#1», «Apify#2»; null — не про аккаунт.
  account        text,
  creator_handle text,
  text           text not null,
  -- Сколько стоила операция и сколько осталось у аккаунта после неё (в его единицах).
  units_spent    numeric,
  units_left     numeric,
  -- Единица счёта аккаунта: 'units' (EnsembleData, в день) или 'usd' (Apify, в месяц).
  units_kind     text
);
create index sync_log_run_idx on public.sync_log (run_id, id);

alter table public.sync_log enable row level security;
-- Только администратор: менеджерам ход обхода не показывается.
create policy "admin reads sync_log" on public.sync_log
  for select to authenticated using ((select public.is_admin()));

alter publication supabase_realtime add table public.sync_log;

-- Итог по аккаунтам за обход: [{ account, source, spent, left, kind, calls }] — для строки
-- «Обновлено … · ED#1 12 ед., Apify#2 $0,04» без чтения всего журнала.
alter table public.sync_runs
  add column accounts jsonb not null default '[]'::jsonb,
  -- Каким путём шёл обход в целом: 'providers' | 'browser' | 'mixed'.
  add column source text;

comment on table public.sync_log is 'Живой ход обхода для администратора: строки пишет сборщик по мере работы.';
comment on column public.sync_runs.accounts is 'Итог по аккаунтам провайдеров за обход: потрачено, осталось, вызовов.';
