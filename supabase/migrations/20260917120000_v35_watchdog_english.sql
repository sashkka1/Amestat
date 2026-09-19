-- Версия 35 (владелец, 2026-09-17): «абсолютно всё нужно переводить» — русского в Amestat не
-- остаётся ни в одной строке, которую программа выдаёт наружу. Сторож повисших просьб (v8/v9)
-- шлёт владельцу в Telegram русский текст; тело функции то же, изменены только строки.

create or replace function private.notify_stale_requests()
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
      E'\n• %s asks to refresh %s (%s), waiting since %s',
      r.login,
      case when r.handle is null then 'all creators' else '@' || r.handle end,
      case when r.depth = 'week' then 'last week' else 'everything' end,
      to_char(r.requested_at at time zone 'Europe/Minsk', 'HH24:MI')
    );
  end loop;

  if n = 0 then
    return 0;
  end if;

  perform net.http_post(
    url  := 'https://api.telegram.org/bot' || tok || '/sendMessage',
    body := jsonb_build_object(
      'chat_id', chat,
      'text', 'Amestat: the site asked for a refresh, but the home collector has not answered for more than 3 minutes.'
              || body
              || E'\nTurn on the computer or check the resident: the requests will run as soon as it wakes up.'
    )
  );

  update public.sync_requests set notified_at = now() where id = any(ids);
  return n;
end;
$$;
