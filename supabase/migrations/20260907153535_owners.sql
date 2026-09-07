-- Замок на конкретного пользователя, а не на роль.
--
-- Сайт — статика на GitHub Pages: публичный ключ лежит в JS у всех на виду, и любой, кто
-- зарегистрируется в Auth, получит роль `authenticated`. Политики вида
-- `to authenticated using (true)` пустили бы его к данным целиком. Регистрацию мы
-- выключаем в панели, но замок не должен держаться на одном тумблере: доступ есть только
-- у тех, кто записан в `owners`. Строку туда кладёт service_role (панель или сборщик),
-- сама по себе она не появляется.

create table public.owners (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);

comment on table public.owners is 'Кому открыт сайт. Заполняется руками с service_role; RLS всех таблиц смотрит сюда.';

alter table public.owners enable row level security;

create policy "owner sees own row" on public.owners
  for select to authenticated using (user_id = (select auth.uid()));

create function public.is_owner()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (select 1 from public.owners o where o.user_id = (select auth.uid()));
$$;

revoke execute on function public.is_owner() from anon;

-- ---------------------------------------------------------------------------------------
-- Те же политики, что были, но с замком. `(select public.is_owner())` — чтобы Postgres
-- посчитал его один раз на запрос, а не на каждую строку.
-- ---------------------------------------------------------------------------------------

drop policy "owner reads creators"       on public.creators;
drop policy "owner writes creators"      on public.creators;
drop policy "owner updates creators"     on public.creators;
drop policy "owner deletes creators"     on public.creators;
drop policy "owner reads tags"           on public.tags;
drop policy "owner writes tags"          on public.tags;
drop policy "owner updates tags"         on public.tags;
drop policy "owner deletes tags"         on public.tags;
drop policy "owner reads creator_tags"   on public.creator_tags;
drop policy "owner writes creator_tags"  on public.creator_tags;
drop policy "owner deletes creator_tags" on public.creator_tags;
drop policy "owner reads creator_snaps"  on public.creator_snaps;
drop policy "owner reads videos"         on public.videos;
drop policy "owner marks videos"         on public.videos;
drop policy "owner reads video_snaps"    on public.video_snaps;
drop policy "owner reads sync_runs"      on public.sync_runs;
drop policy "owner reads sync_requests"  on public.sync_requests;
drop policy "owner asks for sync"        on public.sync_requests;

create policy "owner reads creators"       on public.creators      for select to authenticated using ((select public.is_owner()));
create policy "owner writes creators"      on public.creators      for insert to authenticated with check ((select public.is_owner()));
create policy "owner updates creators"     on public.creators      for update to authenticated using ((select public.is_owner())) with check ((select public.is_owner()));
create policy "owner deletes creators"     on public.creators      for delete to authenticated using ((select public.is_owner()));

create policy "owner reads tags"           on public.tags          for select to authenticated using ((select public.is_owner()));
create policy "owner writes tags"          on public.tags          for insert to authenticated with check ((select public.is_owner()));
create policy "owner updates tags"         on public.tags          for update to authenticated using ((select public.is_owner())) with check ((select public.is_owner()));
create policy "owner deletes tags"         on public.tags          for delete to authenticated using ((select public.is_owner()));

create policy "owner reads creator_tags"   on public.creator_tags  for select to authenticated using ((select public.is_owner()));
create policy "owner writes creator_tags"  on public.creator_tags  for insert to authenticated with check ((select public.is_owner()));
create policy "owner deletes creator_tags" on public.creator_tags  for delete to authenticated using ((select public.is_owner()));

create policy "owner reads creator_snaps"  on public.creator_snaps for select to authenticated using ((select public.is_owner()));
create policy "owner reads videos"         on public.videos        for select to authenticated using ((select public.is_owner()));
create policy "owner marks videos"         on public.videos        for update to authenticated using ((select public.is_owner())) with check ((select public.is_owner()));
create policy "owner reads video_snaps"    on public.video_snaps   for select to authenticated using ((select public.is_owner()));
create policy "owner reads sync_runs"      on public.sync_runs     for select to authenticated using ((select public.is_owner()));

create policy "owner reads sync_requests"  on public.sync_requests for select to authenticated using ((select public.is_owner()));
create policy "owner asks for sync"        on public.sync_requests for insert to authenticated with check ((select public.is_owner()));

-- Картинки: читать может любой (адрес уходит в <img>), писать — только владелец.
drop policy "owner uploads avatars"  on storage.objects;
drop policy "owner replaces avatars" on storage.objects;
drop policy "owner deletes avatars"  on storage.objects;

create policy "owner uploads avatars"  on storage.objects for insert to authenticated with check (bucket_id = 'avatars' and (select public.is_owner()));
create policy "owner replaces avatars" on storage.objects for update to authenticated using (bucket_id = 'avatars' and (select public.is_owner())) with check (bucket_id = 'avatars' and (select public.is_owner()));
create policy "owner deletes avatars"  on storage.objects for delete to authenticated using (bucket_id = 'avatars' and (select public.is_owner()));
