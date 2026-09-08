-- Версия 2 (владелец, 2026-09-08): официальный API TikTok вместо своего браузера, две роли,
-- приглашения по ссылке, архив удалённых, теги у каждого свои, статистика первой.
--
-- Решения владельца, на которых это построено:
--   1. Sashboard от обхода освобождён; сбор — функции Supabase по расписанию 3 раза в день.
--   2. Менеджер со своими креаторами может всё, включая удаление; у админа — архив «кто удалил».
--   3. Креатор может быть у двух менеджеров сразу, виден обоим.
--   4. Админ генерирует одноразовую ссылку регистрации; менеджер сам вводит логин и пароль;
--      у админа журнал ссылок: кто и когда воспользовался, сколько дней назад отправлена.
--   5. Теги у каждого пользователя свои.
--   8. Креатор, подключённый по ссылке, — «все видео наши» по умолчанию.

-- =========================================================================================
-- 1. Роли
-- =========================================================================================

create table public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  role         text not null check (role in ('admin', 'manager')),
  -- Что ввёл при регистрации. Для входа в Auth используется email: сам логин, если он
  -- похож на почту, иначе `<логин>@amestat.invalid` — писем мы не шлём, адрес не важен.
  login        text not null unique,
  display_name text not null default '',
  invited_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now()
);

comment on table public.profiles is 'Роль пользователя сайта. Заводится функциями register / setup, не сайтом.';

-- Прежние владельцы становятся администраторами.
insert into public.profiles (user_id, role, login)
select o.user_id, 'admin', coalesce(u.email, o.user_id::text)
from public.owners o
join auth.users u on u.id = o.user_id;

create function public.is_admin()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.user_id = (select auth.uid()) and p.role = 'admin'
  );
$$;

create function public.current_role_name()
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select p.role from public.profiles p where p.user_id = (select auth.uid());
$$;

revoke execute on function public.is_admin() from anon;
revoke execute on function public.current_role_name() from anon;

alter table public.profiles enable row level security;

create policy "user sees own profile"   on public.profiles for select to authenticated using (user_id = (select auth.uid()));
create policy "admin sees all profiles" on public.profiles for select to authenticated using ((select public.is_admin()));
create policy "admin edits profiles"    on public.profiles for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- =========================================================================================
-- 2. Приглашения — одноразовые ссылки регистрации менеджера
-- =========================================================================================

create table public.invites (
  id         uuid primary key default gen_random_uuid(),
  token      text not null unique,
  note       text not null default '',
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  used_at    timestamptz,
  used_by    uuid references auth.users (id) on delete set null
);

comment on table public.invites is 'Ссылки регистрации менеджеров. Выпускает функция invite, гасит функция register.';

alter table public.invites enable row level security;

create policy "admin sees invites" on public.invites for select to authenticated using ((select public.is_admin()));
create policy "admin deletes invites" on public.invites for delete to authenticated using ((select public.is_admin()));

-- =========================================================================================
-- 3. Креаторы: кто подключил, привязка к менеджерам, ключи TikTok
-- =========================================================================================

alter table public.creators
  add column connected_by   uuid references auth.users (id) on delete set null,
  add column tiktok_open_id text unique,
  -- Кому не пришёл обход из-за ключа: «нужно переподключить» ставит функция collect.
  add column needs_reconnect boolean not null default false;

create table public.creator_managers (
  creator_id  uuid not null references public.creators (id) on delete cascade,
  manager_id  uuid not null references auth.users (id) on delete cascade,
  assigned_by uuid references auth.users (id) on delete set null,
  assigned_at timestamptz not null default now(),
  primary key (creator_id, manager_id)
);

create index creator_managers_manager_idx on public.creator_managers (manager_id);

alter table public.creator_managers enable row level security;

-- Видимость креатора: админ — все, менеджер — по связи.
create function public.can_see_creator(p_creator uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select (select public.is_admin())
      or exists (
        select 1 from public.creator_managers cm
        where cm.creator_id = p_creator and cm.manager_id = (select auth.uid())
      );
$$;

revoke execute on function public.can_see_creator(uuid) from anon;

create policy "sees own links"     on public.creator_managers for select to authenticated using (manager_id = (select auth.uid()) or (select public.is_admin()));
create policy "admin assigns"      on public.creator_managers for insert to authenticated with check ((select public.is_admin()));
create policy "admin unassigns"    on public.creator_managers for delete to authenticated using ((select public.is_admin()));

-- Ключи креаторов — в закрытой схеме: сайт их не видит никогда, только функции с service_role.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table private.tiktok_accounts (
  creator_id         uuid primary key references public.creators (id) on delete cascade,
  open_id            text not null unique,
  access_token       text not null,
  refresh_token      text not null,
  expires_at         timestamptz not null,
  refresh_expires_at timestamptz not null,
  scope              text not null default '',
  updated_at         timestamptz not null default now()
);

-- =========================================================================================
-- 4. Теги — у каждого свои
-- =========================================================================================

alter table public.tags
  add column owner_id uuid references auth.users (id) on delete cascade;

-- Существующие теги — первому администратору.
update public.tags set owner_id = (select user_id from public.profiles where role = 'admin' order by created_at limit 1)
where owner_id is null;

alter table public.tags alter column owner_id set not null;
alter table public.tags drop constraint if exists tags_name_key;
alter table public.tags add constraint tags_owner_name_key unique (owner_id, name);

-- =========================================================================================
-- 5. Архив удалённых креаторов — кто и когда
-- =========================================================================================

create table public.creators_archive (
  id           uuid primary key,
  platform     text not null,
  handle       text not null,
  display_name text not null,
  description  text not null,
  avatar_url   text,
  profile_url  text not null,
  added_at     timestamptz not null,
  managers     text[] not null default '{}',
  deleted_at   timestamptz not null default now(),
  deleted_by   uuid,
  deleted_by_login text not null default ''
);

alter table public.creators_archive enable row level security;
create policy "admin sees archive" on public.creators_archive for select to authenticated using ((select public.is_admin()));

create function public.archive_creator()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  who uuid := auth.uid();
  who_login text;
begin
  select p.login into who_login from public.profiles p where p.user_id = who;
  insert into public.creators_archive (id, platform, handle, display_name, description, avatar_url, profile_url, added_at, managers, deleted_at, deleted_by, deleted_by_login)
  values (
    old.id, old.platform, old.handle, old.display_name, old.description, old.avatar_url, old.profile_url, old.added_at,
    coalesce((select array_agg(p.login order by p.login) from public.creator_managers cm join public.profiles p on p.user_id = cm.manager_id where cm.creator_id = old.id), '{}'),
    now(), who, coalesce(who_login, 'система')
  )
  on conflict (id) do update set deleted_at = excluded.deleted_at, deleted_by = excluded.deleted_by, deleted_by_login = excluded.deleted_by_login, managers = excluded.managers;
  return old;
end;
$$;

-- security definer нужен ровно потому, что триггер пишет в архив от имени менеджера,
-- у которого на архив прав нет. Функция ничего не читает по аргументам снаружи.
revoke execute on function public.archive_creator() from public, anon, authenticated;

create trigger creators_archive
  before delete on public.creators
  for each row execute function public.archive_creator();

-- =========================================================================================
-- 6. Просьбы с сайта больше не нужны: сайт зовёт функцию sync напрямую, расписание — pg_cron.
-- =========================================================================================

drop table public.sync_requests;

alter table public.sync_runs
  add column requested_by uuid references auth.users (id) on delete set null,
  add column scope text not null default 'all';

-- =========================================================================================
-- 7. RLS заново: админ — всё, менеджер — только свои креаторы
-- =========================================================================================

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
drop policy "owner uploads avatars"      on storage.objects;
drop policy "owner replaces avatars"     on storage.objects;
drop policy "owner deletes avatars"      on storage.objects;

-- Креаторы. Вставка руками с сайта больше не нужна (подключение — только через TikTok),
-- но админу оставлена: например, чтобы завести карточку до подключения.
create policy "sees visible creators"    on public.creators for select to authenticated using ((select public.can_see_creator(id)));
create policy "admin adds creators"      on public.creators for insert to authenticated with check ((select public.is_admin()));
create policy "edits visible creators"   on public.creators for update to authenticated using ((select public.can_see_creator(id))) with check ((select public.can_see_creator(id)));
create policy "deletes visible creators" on public.creators for delete to authenticated using ((select public.can_see_creator(id)));

-- Теги — только свои.
create policy "own tags select" on public.tags for select to authenticated using (owner_id = (select auth.uid()));
create policy "own tags insert" on public.tags for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "own tags update" on public.tags for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "own tags delete" on public.tags for delete to authenticated using (owner_id = (select auth.uid()));

-- Связь тег—креатор: свой тег на видимого креатора.
create policy "own creator_tags select" on public.creator_tags for select to authenticated
  using (exists (select 1 from public.tags t where t.id = tag_id and t.owner_id = (select auth.uid())));
create policy "own creator_tags insert" on public.creator_tags for insert to authenticated
  with check (exists (select 1 from public.tags t where t.id = tag_id and t.owner_id = (select auth.uid())) and (select public.can_see_creator(creator_id)));
create policy "own creator_tags delete" on public.creator_tags for delete to authenticated
  using (exists (select 1 from public.tags t where t.id = tag_id and t.owner_id = (select auth.uid())));

create policy "sees visible snaps"  on public.creator_snaps for select to authenticated using ((select public.can_see_creator(creator_id)));
create policy "sees visible videos" on public.videos        for select to authenticated using ((select public.can_see_creator(creator_id)));
create policy "marks visible videos" on public.videos       for update to authenticated using ((select public.can_see_creator(creator_id))) with check ((select public.can_see_creator(creator_id)));
create policy "sees visible video_snaps" on public.video_snaps for select to authenticated
  using (exists (select 1 from public.videos v where v.id = video_id and public.can_see_creator(v.creator_id)));

-- Обходы видят все вошедшие с ролью: строка обхода не содержит чужих данных, только счётчики.
create policy "members see sync_runs" on public.sync_runs for select to authenticated using ((select public.current_role_name()) is not null);

create policy "members upload avatars"  on storage.objects for insert to authenticated with check (bucket_id = 'avatars' and (select public.current_role_name()) is not null);
create policy "members replace avatars" on storage.objects for update to authenticated using (bucket_id = 'avatars' and (select public.current_role_name()) is not null) with check (bucket_id = 'avatars' and (select public.current_role_name()) is not null);
create policy "members delete avatars"  on storage.objects for delete to authenticated using (bucket_id = 'avatars' and (select public.current_role_name()) is not null);

-- Замок owners больше не источник правды — роли в profiles.
drop policy "owner sees own row" on public.owners;
drop function public.is_owner();
drop table public.owners;

-- =========================================================================================
-- 8. Сводка для главной: по видимым креаторам за срок, одним запросом
-- =========================================================================================

create function public.creators_overview(p_from timestamptz, p_to timestamptz)
returns table (
  creator_id        uuid,
  followers_now     bigint,
  followers_delta   bigint,
  videos_total      bigint,
  videos_published  bigint,
  views_delta       bigint,
  likes_delta       bigint,
  comments_delta    bigint,
  shares_delta      bigint,
  saves_delta       bigint,
  median_views_delta double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  with vis as (
    select c.id from public.creators c   -- RLS сама оставит видимых
  ),
  fol_now as (
    select distinct on (s.creator_id) s.creator_id, s.followers
    from public.creator_snaps s join vis on vis.id = s.creator_id
    where s.taken_at <= p_to order by s.creator_id, s.taken_at desc
  ),
  fol_before as (
    select distinct on (s.creator_id) s.creator_id, s.followers
    from public.creator_snaps s join vis on vis.id = s.creator_id
    where s.taken_at <= p_from order by s.creator_id, s.taken_at desc
  ),
  fol_first_inside as (
    select distinct on (s.creator_id) s.creator_id, s.followers
    from public.creator_snaps s join vis on vis.id = s.creator_id
    where s.taken_at > p_from and s.taken_at <= p_to order by s.creator_id, s.taken_at asc
  ),
  per_video as (
    select v.creator_id, st.*
    from vis
    join public.videos v on v.creator_id = vis.id and v.ours
    cross join lateral (
      select
        f.views  - coalesce(b.views,  case when v.published_at >= p_from then 0 else fi.views  end, 0) as views_delta,
        f.likes  - coalesce(b.likes,  case when v.published_at >= p_from then 0 else fi.likes  end, 0) as likes_delta,
        f.comments - coalesce(b.comments, case when v.published_at >= p_from then 0 else fi.comments end, 0) as comments_delta,
        f.shares - coalesce(b.shares, case when v.published_at >= p_from then 0 else fi.shares end, 0) as shares_delta,
        f.saves  - coalesce(b.saves,  case when v.published_at >= p_from then 0 else fi.saves  end, 0) as saves_delta
      from (
        select s.views, s.likes, s.comments, s.shares, s.saves from public.video_snaps s
        where s.video_id = v.id and s.taken_at <= p_to order by s.taken_at desc limit 1
      ) f
      left join lateral (
        select s.views, s.likes, s.comments, s.shares, s.saves from public.video_snaps s
        where s.video_id = v.id and s.taken_at <= p_from order by s.taken_at desc limit 1
      ) b on true
      left join lateral (
        select s.views, s.likes, s.comments, s.shares, s.saves from public.video_snaps s
        where s.video_id = v.id and s.taken_at > p_from and s.taken_at <= p_to order by s.taken_at asc limit 1
      ) fi on true
    ) st
  )
  select
    vis.id,
    fn.followers,
    case when fn.followers is null then null else fn.followers - coalesce(fb.followers, ff.followers) end,
    (select count(*) from public.videos v where v.creator_id = vis.id and v.ours),
    (select count(*) from public.videos v where v.creator_id = vis.id and v.ours and v.published_at >= p_from and v.published_at <= p_to),
    coalesce((select sum(greatest(pv.views_delta, 0))    from per_video pv where pv.creator_id = vis.id), 0),
    coalesce((select sum(greatest(pv.likes_delta, 0))    from per_video pv where pv.creator_id = vis.id), 0),
    coalesce((select sum(greatest(pv.comments_delta, 0)) from per_video pv where pv.creator_id = vis.id), 0),
    coalesce((select sum(greatest(pv.shares_delta, 0))   from per_video pv where pv.creator_id = vis.id), 0),
    coalesce((select sum(greatest(pv.saves_delta, 0))    from per_video pv where pv.creator_id = vis.id), 0),
    (select percentile_cont(0.5) within group (order by greatest(pv.views_delta, 0)) from per_video pv where pv.creator_id = vis.id and pv.views_delta > 0)
  from vis
  left join fol_now fn on fn.creator_id = vis.id
  left join fol_before fb on fb.creator_id = vis.id
  left join fol_first_inside ff on ff.creator_id = vis.id;
$$;

-- График на главной: суммарные просмотры всех наших видео видимых креаторов по дням.
create function public.daily_views_all(p_from timestamptz, p_to timestamptz)
returns table (day date, views bigint, likes bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with days as (
    select generate_series(date_trunc('day', p_from), date_trunc('day', p_to), interval '1 day')::date as day
  ),
  per_video_day as (
    select distinct on (d.day, s.video_id) d.day, s.video_id, s.views, s.likes
    from days d
    join public.videos v on v.ours
    join public.creators c on c.id = v.creator_id   -- RLS оставит видимых
    join public.video_snaps s on s.video_id = v.id and s.taken_at < (d.day + 1)::timestamptz
    order by d.day, s.video_id, s.taken_at desc
  )
  select d.day, coalesce(sum(p.views), 0)::bigint, coalesce(sum(p.likes), 0)::bigint
  from days d
  left join per_video_day p on p.day = d.day
  group by d.day
  order by d.day;
$$;

revoke execute on function public.creators_overview(timestamptz, timestamptz) from anon;
revoke execute on function public.daily_views_all(timestamptz, timestamptz) from anon;

-- =========================================================================================
-- 9. Расписание — три раза в день (10:00, 13:00, 17:00 по Минску = 07, 10, 14 UTC).
-- Ключ для вызова функции лежит в Vault, кладёт его скрипт настройки (setup-supabase.mjs),
-- сама задача заводится там же: в миграцию адрес проекта и секрет не попадают.
-- =========================================================================================

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
