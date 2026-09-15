-- Версия 31 (владелец, 2026-09-15): удалить запись из архива насовсем.
--
-- «В архивных я как администратор должен иметь возможность удалять».
--
-- ⚠️ Стирается ОДНА строка архива — вся память о том, что креатор когда-то был: кто его
-- добавил, когда удалили и у каких менеджеров он был. Видео, снимки и комментарии ушли
-- каскадом ещё в момент удаления креатора (триггер `creators_archive` пишет строку архива
-- перед удалением), поэтому стирать по ним нечего.
-- ⚠️ После этого «Вернуть» по записи невозможно: восстанавливать неоткуда. Необратимо —
-- поэтому на сайте кнопка спрашивает подтверждение, в отличие от «Вернуть».

create function public.purge_archived_creator(p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.creators_archive%rowtype;
begin
  -- Архив видит только админ (политика "admin sees archive"), стирать может тоже только он.
  if not (select public.is_admin()) then
    raise exception 'Удалить запись архива может только администратор' using errcode = '42501';
  end if;

  select * into a from public.creators_archive where id = p_id;
  if not found then
    raise exception 'Этой записи в архиве уже нет' using errcode = 'P0001';
  end if;

  delete from public.creators_archive where id = a.id;
  -- Наружу уходит handle: сайту нужно назвать в сообщении того, кого стёрли.
  return a.handle;
end;
$$;

-- security definer нужен потому, что на creators_archive у админа есть только select
-- (политика "admin sees archive"), а удалять строку кто-то должен. Проверка прав —
-- is_admin() внутри, первой строкой, как в restore_creator (v25).
revoke execute on function public.purge_archived_creator(uuid) from public, anon;
grant execute on function public.purge_archived_creator(uuid) to authenticated;
