-- Версия 25 (владелец, 2026-09-10): вернуть креатора из архива одной кнопкой.
--
-- «В архиве нужна возможность вернуть креатора: сейчас приходится идти на его страницу,
-- копировать ссылку и заводить заново — неудобно».
--
-- ⚠️ Возвращается только КАРТОЧКА. Видео, снимки и комментарии ушли каскадом в момент
-- удаления и не восстанавливаются — их соберёт заново ближайший обход. Так и задумано:
-- архив хранит одну строку, а не копию всей истории.

create function public.restore_creator(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.creators_archive%rowtype;
  next_order integer;
begin
  -- Архив видит только админ (политика "admin sees archive"), возвращать может тоже только он.
  if not (select public.is_admin()) then
    raise exception 'Вернуть креатора из архива может только администратор' using errcode = '42501';
  end if;

  select * into a from public.creators_archive where id = p_id;
  if not found then
    raise exception 'Этой записи в архиве уже нет' using errcode = 'P0001';
  end if;

  -- Пара (platform, handle) в creators уникальна: если креатора успели завести заново,
  -- вставка упала бы кодом 23505 без внятного текста.
  if exists (select 1 from public.creators c where c.platform = a.platform and c.handle = a.handle) then
    raise exception 'Креатор @% на этой площадке уже заведён — верните его из архива после удаления карточки-двойника', a.handle
      using errcode = 'P0001';
  end if;

  -- Возвращённый встаёт в конец порядка — как новый (см. createCreator на сайте).
  select coalesce(max(c.sort_order), 0) + 1 into next_order from public.creators c;

  insert into public.creators (
    id, platform, handle, display_name, description, avatar_url, profile_url, added_at, sort_order
  )
  values (
    a.id, a.platform, a.handle, a.display_name, a.description, a.avatar_url, a.profile_url, a.added_at, next_order
  );
  -- all_videos_ours намеренно не переносим: в архиве его нет, берётся умолчание таблицы.

  -- Менеджеры в архиве записаны ЛОГИНАМИ (archive_creator() складывает туда profiles.login).
  -- Возвращаем только тех, кто существует сейчас: уволенного менеджера привязать не к кому.
  insert into public.creator_managers (creator_id, manager_id, assigned_by)
  select a.id, p.user_id, auth.uid()
  from public.profiles p
  where p.login = any (a.managers)
  on conflict (creator_id, manager_id) do nothing;

  delete from public.creators_archive where id = a.id;
  return a.id;
end;
$$;

-- security definer нужен потому, что функция пишет в creators_archive (там только select
-- даже у админа) и в creator_managers. Проверка прав — is_admin() внутри, первой строкой.
revoke execute on function public.restore_creator(uuid) from public, anon;
grant execute on function public.restore_creator(uuid) to authenticated;
