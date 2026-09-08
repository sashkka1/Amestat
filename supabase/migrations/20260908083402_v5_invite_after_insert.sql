-- Версия 5 (2026-09-08): триггер регистрации переносится на AFTER INSERT.
--
-- Живая проба: `signUp` по приглашению падал с «Database error saving new user» — BEFORE-триггер
-- вставлял профиль, когда строки в auth.users ещё не было, и внешний ключ profiles.user_id
-- это отвергал. Заодно: Supabase прячет текст исключения триггера за общим «Database error»,
-- поэтому проверка приглашения и логина выносится в функции, которые сайт зовёт ДО signUp,
-- а триггер остаётся замком на случай обхода сайта.

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

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
  if tok is null then
    if (new.raw_user_meta_data ->> 'via_signup') = 'true' then
      raise exception 'Регистрация только по приглашению' using errcode = 'P0001';
    end if;
    return new;   -- пользователь из панели или скрипта: профиль ставит setup
  end if;

  select * into inv from public.invites where token = tok for update;
  if not found then raise exception 'Ссылка недействительна' using errcode = 'P0001'; end if;
  if inv.used_at is not null then raise exception 'Ссылка уже использована' using errcode = 'P0001'; end if;
  if inv.expires_at < now() then raise exception 'Срок ссылки истёк' using errcode = 'P0001'; end if;
  if exists (select 1 from public.profiles p where lower(p.login) = lower(login_text)) then
    raise exception 'Такой логин уже занят' using errcode = 'P0001';
  end if;

  insert into public.profiles (user_id, role, login, display_name, invited_by)
  values (new.id, 'manager', login_text, coalesce(new.raw_user_meta_data ->> 'display_name', ''), inv.created_by);

  update public.invites set used_at = now(), used_by = new.id where id = inv.id;

  -- Писем не шлём: подтверждаем почту сразу, иначе вход по .invalid-адресу невозможен.
  update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = new.id;
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Проверка до регистрации: сайт показывает причину по-русски, а не «Database error».
create function public.check_invite(p_token text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when i.id is null then 'invalid'
    when i.used_at is not null then 'used'
    when i.expires_at < now() then 'expired'
    else 'ok'
  end
  from (select 1) x
  left join public.invites i on i.token = p_token;
$$;

create function public.login_taken(p_login text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles p where lower(p.login) = lower(p_login));
$$;

grant execute on function public.check_invite(text) to anon, authenticated;
grant execute on function public.login_taken(text) to anon, authenticated;
