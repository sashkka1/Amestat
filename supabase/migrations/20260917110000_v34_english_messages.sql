-- Версия 34 (владелец, 2026-09-17): русского на сайте не остаётся нигде.
--
-- Сайт с 2026-09-09 живёт на EN/PT, но тексты, которые бросает сама база (`raise exception`
-- с кодами P0001 / 42501), он показывает как есть — `lib/api/result.ts`, `isRaised`. Так
-- «Только администратор», «Этой записи в архиве уже нет» и подпись «система» у архивной
-- отметки доходили до экрана по-русски. Здесь те же функции с теми же телами, изменены
-- только строки сообщений; уже записанные «система» переписаны на 'system'.
--
-- Английский, а не язык вкладки: база языка сайта не знает, а английский — исходный словарь.

-- ---------------------------------------------------------------------------------------
-- Регистрация по приглашению (v5). Тексты триггера Supabase наружу не отдаёт (общее
-- «Database error saving new user»), но оставлять русский незачем и здесь.
-- ---------------------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  tok text := new.raw_user_meta_data ->> 'invite';
  inv public.invites%rowtype;
  login_text text := coalesce(nullif(new.raw_user_meta_data ->> 'login', ''), new.email, new.id::text);
begin
  if tok is null then
    if (new.raw_user_meta_data ->> 'via_signup') = 'true' then
      raise exception 'Registration is by invitation only' using errcode = 'P0001';
    end if;
    return new;   -- пользователь из панели или скрипта: профиль ставит setup
  end if;

  select * into inv from public.invites where token = tok for update;
  if not found then raise exception 'This link is not valid' using errcode = 'P0001'; end if;
  if inv.used_at is not null then raise exception 'This link has already been used' using errcode = 'P0001'; end if;
  if inv.expires_at < now() then raise exception 'This link has expired' using errcode = 'P0001'; end if;
  if exists (select 1 from public.profiles p where lower(p.login) = lower(login_text)) then
    raise exception 'This login is already taken' using errcode = 'P0001';
  end if;

  insert into public.profiles (user_id, role, login, display_name, invited_by)
  values (new.id, 'manager', login_text, coalesce(new.raw_user_meta_data ->> 'display_name', ''), inv.created_by);

  update public.invites set used_at = now(), used_by = new.id where id = inv.id;

  -- Писем не шлём: подтверждаем почту сразу, иначе вход по .invalid-адресу невозможен.
  update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = new.id;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Пароль менеджеру (v3)
-- ---------------------------------------------------------------------------------------

create or replace function public.admin_set_password(p_user uuid, p_password text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select public.is_admin()) then
    raise exception 'Administrators only' using errcode = '42501';
  end if;
  if length(p_password) < 8 then
    raise exception 'Password is shorter than 8 characters' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.profiles where user_id = p_user and role = 'manager') then
    raise exception 'This user is not a manager' using errcode = 'P0001';
  end if;
  update auth.users
  set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
      updated_at = now()
  where id = p_user;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Настройки Telegram (v8)
-- ---------------------------------------------------------------------------------------

create or replace function public.set_setting(p_key text, p_value text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (
    (select public.is_admin())
    or coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '') = 'service_role'
  ) then
    raise exception 'Administrators only' using errcode = '42501';
  end if;
  insert into private.settings (key, value, updated_at)
  values (p_key, p_value, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Старый архив `creators_archive`: вернуть (v25) и стереть (v31)
-- ---------------------------------------------------------------------------------------

create or replace function public.restore_creator(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.creators_archive%rowtype;
  next_order integer;
begin
  if not (select public.is_admin()) then
    raise exception 'Only an administrator can restore a creator from the archive' using errcode = '42501';
  end if;

  select * into a from public.creators_archive where id = p_id;
  if not found then
    raise exception 'This archive record no longer exists' using errcode = 'P0001';
  end if;

  if exists (select 1 from public.creators c where c.platform = a.platform and c.handle = a.handle) then
    raise exception 'Creator @% already exists on this platform — delete the duplicate card first, then restore', a.handle
      using errcode = 'P0001';
  end if;

  select coalesce(max(c.sort_order), 0) + 1 into next_order from public.creators c;

  insert into public.creators (
    id, platform, handle, display_name, description, avatar_url, profile_url, added_at, sort_order
  )
  values (
    a.id, a.platform, a.handle, a.display_name, a.description, a.avatar_url, a.profile_url, a.added_at, next_order
  );

  insert into public.creator_managers (creator_id, manager_id, assigned_by)
  select a.id, p.user_id, auth.uid()
  from public.profiles p
  where p.login = any (a.managers)
  on conflict (creator_id, manager_id) do nothing;

  delete from public.creators_archive where id = a.id;
  return a.id;
end;
$$;

create or replace function public.purge_archived_creator(p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.creators_archive%rowtype;
begin
  if not (select public.is_admin()) then
    raise exception 'Only an administrator can delete an archive record' using errcode = '42501';
  end if;

  select * into a from public.creators_archive where id = p_id;
  if not found then
    raise exception 'This archive record no longer exists' using errcode = 'P0001';
  end if;

  delete from public.creators_archive where id = a.id;
  return a.handle;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Архив с историей (v32): отметка, возврат, корзина
-- ---------------------------------------------------------------------------------------

create or replace function public.set_creator_archived(p_id uuid, p_on boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  who uuid := auth.uid();
  who_login text;
begin
  if not (select public.is_admin()) then
    raise exception 'Only an administrator can archive and restore creators' using errcode = '42501';
  end if;

  if p_on then
    select p.login into who_login from public.profiles p where p.user_id = who;
    update public.creators
       set archived_at = now(), archived_by = who, archived_by_login = coalesce(who_login, 'system')
     where id = p_id;
  else
    update public.creators
       set archived_at = null, archived_by = null, archived_by_login = ''
     where id = p_id;
  end if;

  if not found then
    raise exception 'This creator is not in the database' using errcode = 'P0001';
  end if;
  return p_id;
end;
$$;

create or replace function public.purge_creator(p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  gone text;
begin
  if not (select public.is_admin()) then
    raise exception 'Only an administrator can delete a creator permanently' using errcode = '42501';
  end if;

  delete from public.creators where id = p_id returning handle into gone;
  if gone is null then
    raise exception 'This creator is not in the database' using errcode = 'P0001';
  end if;
  return gone;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Уже записанная подпись «система» (архивная отметка без логина) — на сайте видна как есть.
-- ---------------------------------------------------------------------------------------

update public.creators set archived_by_login = 'system' where archived_by_login = 'система';
update public.creators_archive set deleted_by_login = 'system' where deleted_by_login = 'система';
