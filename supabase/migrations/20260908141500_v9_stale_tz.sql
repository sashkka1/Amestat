-- Версия 9 (2026-09-08): время в сообщении сторожа — по часам владельца (Минск, UTC+3),
-- а не по Варшаве, как было написано в v8 по ошибке.

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
      E'\n• %s просит обновить %s (%s), ждёт с %s',
      r.login,
      case when r.handle is null then 'всех креаторов' else '@' || r.handle end,
      case when r.depth = 'week' then 'за неделю' else 'всё' end,
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
      'text', 'Amestat: с сайта просят обновить, а домашний сборщик не отвечает больше 3 минут.'
              || body
              || E'\nВключи компьютер или проверь резидент: просьбы выполнятся, как только он проснётся.'
    )
  );

  update public.sync_requests set notified_at = now() where id = any(ids);
  return n;
end;
$$;
