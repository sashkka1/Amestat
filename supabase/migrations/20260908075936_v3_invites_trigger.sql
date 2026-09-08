-- Версия 3 (2026-09-08): подключение менеджера и смена пароля без облачных функций.
--
-- Владелец: «продумать логику с подключением менеджера и реализовать её… эта логика 100%
-- будет работать так». Функции Supabase развернуть пока нечем (нет личного токена), поэтому
-- всё, что нужно менеджеру, живёт в базе:
--   • админ выпускает приглашение обычной вставкой в `invites` (RLS ниже);
--   • менеджер регистрируется штатным `signUp` с токеном приглашения в метаданных, а
--     триггер на `auth.users` проверяет токен и заводит профиль — без токена или с
--     погашенным регистрация отклоняется, поэтому «Allow new users to sign up» в панели
--     должен быть ВКЛЮЧЁН, замок — этот триггер;
--   • пароль менеджеру админ меняет функцией `admin_set_password`, старого не видя.

-- ---------------------------------------------------------------------------------------
-- 1. Приглашения: админ выпускает сам, токен генерирует база.
-- ---------------------------------------------------------------------------------------

alter table public.invites alter column token set default encode(gen_random_bytes(24), 'hex');

create policy "admin creates invites" on public.invites
  for insert to authenticated with check ((select public.is_admin()) and created_by = (select auth.uid()));

-- ---------------------------------------------------------------------------------------
-- 2. Регистрация по приглашению — триггер на auth.users.
-- ---------------------------------------------------------------------------------------

create function public.handle_new_user()
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
  -- Пользователь, заведённый из панели или скриптом (service_role), приходит без токена:
  -- ему профиль не заводим, это дело setup-скрипта. Обычная регистрация без токена — отказ.
  if tok is null then
    if coalesce(new.raw_app_meta_data ->> 'provider', '') = 'email'
       and (new.raw_user_meta_data ->> 'via_signup') = 'true' then
      raise exception 'Регистрация только по приглашению' using errcode = 'P0001';
    end if;
    return new;
  end if;

  select * into inv from public.invites where token = tok for update;
  if not found then
    raise exception 'Ссылка недействительна' using errcode = 'P0001';
  end if;
  if inv.used_at is not null then
    raise exception 'Ссылка уже использована' using errcode = 'P0001';
  end if;
  if inv.expires_at < now() then
    raise exception 'Срок ссылки истёк' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.profiles p where lower(p.login) = lower(login_text)) then
    raise exception 'Такой логин уже занят' using errcode = 'P0001';
  end if;

  -- Писем не шлём: подтверждаем почту сразу, иначе вход по .invalid-адресу невозможен.
  new.email_confirmed_at := coalesce(new.email_confirmed_at, now());

  insert into public.profiles (user_id, role, login, display_name, invited_by)
  values (new.id, 'manager', login_text, coalesce(new.raw_user_meta_data ->> 'display_name', ''), inv.created_by);

  update public.invites set used_at = now(), used_by = new.id where id = inv.id;
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  before insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------------------
-- 3. Смена пароля менеджеру админом — старый не виден, новый ставится напрямую.
-- ---------------------------------------------------------------------------------------

create extension if not exists pgcrypto with schema extensions;

create function public.admin_set_password(p_user uuid, p_password text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select public.is_admin()) then
    raise exception 'Только администратор' using errcode = '42501';
  end if;
  if length(p_password) < 8 then
    raise exception 'Пароль короче 8 символов' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.profiles where user_id = p_user and role = 'manager') then
    raise exception 'Это не менеджер' using errcode = 'P0001';
  end if;
  update auth.users
  set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
      updated_at = now()
  where id = p_user;
end;
$$;

revoke execute on function public.admin_set_password(uuid, text) from public, anon;
grant execute on function public.admin_set_password(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------
-- 4. Удаление менеджера админом: профиль и связи уходят, пользователь Auth остаётся
-- без профиля и на сайт не попадёт («Доступ не выдан»).
-- ---------------------------------------------------------------------------------------

create policy "admin deletes profiles" on public.profiles
  for delete to authenticated using ((select public.is_admin()) and role = 'manager');
