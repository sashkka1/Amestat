-- Версия 8 (2026-09-08): просьба с сайта, когда домашний сборщик не отвечает.
--
-- Владелец: «если кто-то хочет обновиться, а комп недоступен — чтобы мне в Telegram падало
-- сообщение», а пользователю на сайте — «обновление в настоящий момент недоступно, сообщение
-- отправлено, в ближайшее время обновим».
--
-- Сборщик в этот момент выключен, поэтому сообщение шлёт сама база: pg_cron раз в минуту
-- ищет просьбы, которые резидент не принял за 3 минуты, и через pg_net зовёт Bot API Telegram.
-- Токен бота и чат владельца лежат в закрытой таблице private.settings (сайту не видна),
-- заполняются функцией set_setting — админом или ключом service_role.

-- ---------------------------------------------------------------------------------------
-- 1. Две отметки у просьбы.
-- ---------------------------------------------------------------------------------------

alter table public.sync_requests
  add column seen_at     timestamptz,
  add column notified_at timestamptz;

comment on column public.sync_requests.seen_at is 'Резидент принял просьбу в очередь: компьютер и сборщик живы, обход начнётся, когда дойдёт очередь.';
comment on column public.sync_requests.notified_at is 'Владельцу ушло сообщение в Telegram: просьба висит без ответа сборщика больше 3 минут.';

-- ---------------------------------------------------------------------------------------
-- 2. Настройки, которые нужны базе без сборщика.
-- ---------------------------------------------------------------------------------------

create table private.settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

comment on table private.settings is 'telegram_bot_token, telegram_chat_id. Сайту не видна; пишется через public.set_setting.';

create function public.set_setting(p_key text, p_value text)
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
    raise exception 'Только администратор' using errcode = '42501';
  end if;
  insert into private.settings (key, value, updated_at)
  values (p_key, p_value, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end;
$$;

revoke execute on function public.set_setting(text, text) from public, anon;
grant execute on function public.set_setting(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- 3. Сторож просьб: одно сообщение за все просьбы, повисшие без ответа.
-- ---------------------------------------------------------------------------------------

create function private.notify_stale_requests()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  tok  text;
  chat text;
  body text := '';
  ids  bigint[] := '{}';
  n    integer := 0;
  r    record;
begin
  select value into tok  from private.settings where key = 'telegram_bot_token';
  select value into chat from private.settings where key = 'telegram_chat_id';
  if coalesce(tok, '') = '' or coalesce(chat, '') = '' then
    return 0;   -- бот не настроен: молчим, просьбы дождутся резидента
  end if;

  for r in
    select q.id, q.requested_at, q.depth,
           coalesce(p.login, '?') as login,
           c.handle
    from public.sync_requests q
    left join public.profiles p on p.user_id = q.requested_by
    left join public.creators c on c.id = q.creator_id
    where q.taken_at is null
      and q.seen_at is null
      and q.notified_at is null
      and q.requested_at < now() - interval '3 minutes'
    order by q.requested_at
  loop
    n := n + 1;
    ids := array_append(ids, r.id);
    body := body || format(
      E'\n• %s просит обновить %s (%s), ждёт с %s',
      r.login,
      case when r.handle is null then 'всех креаторов' else '@' || r.handle end,
      case when r.depth = 'week' then 'за неделю' else 'всё' end,
      to_char(r.requested_at at time zone 'Europe/Warsaw', 'HH24:MI')
    );
  end loop;

  if n = 0 then
    return 0;
  end if;

  perform net.http_post(
    url  := 'https://api.telegram.org/bot' || tok || '/sendMessage',
    body := jsonb_build_object(
      'chat_id', chat,
      'text', 'Amestat: с сайта просят обновить, а домашний сборщик не отвечает больше 3 минут.'
              || body
              || E'\nВключи компьютер или проверь резидент: просьбы выполнятся, как только он проснётся.'
    )
  );

  update public.sync_requests set notified_at = now() where id = any(ids);
  return n;
end;
$$;

revoke execute on function private.notify_stale_requests() from public, anon, authenticated;

-- Раз в минуту. Повторный накат безопасен: прежнюю задачу с тем же именем снимаем.
select cron.unschedule(jobid) from cron.job where jobname = 'amestat-stale-requests';
select cron.schedule('amestat-stale-requests', '* * * * *', $$select private.notify_stale_requests()$$);
