-- Версия 32 (владелец, 2026-09-15): удаление креатора больше не теряет статистику,
-- плюс ручная пауза «этого не обновлять».
--
-- «При удалении статистика не теряется: если восстановить удалённого креатора, то статистика
-- восстановится тоже… он просто перестаёт обновляться, перестаёт отображаться и числится
-- только в архиве». И второе: «креатора, у которого сегодня не нашли профиль, при следующих
-- обходах обновлять не нужно, пусть на сайте висит».
--
-- Как было: сайт делал DELETE, триггер писал строку в `creators_archive`, а видео, снимки и
-- комментарии уходили каскадом. Возвращалась только карточка, история пропадала навсегда.
--
-- Как стало: удаление с карточки — это отметка `archived_at` в самой строке `creators`.
-- Данные целы, «Вернуть» просто гасит отметку, вся история возвращается вместе с ним.
-- Настоящее удаление осталось ровно одно — корзина в архиве (`purge_creator`).
--
-- 🔴 Архивных не видно НИГДЕ, и добивается это ОДНОЙ строкой в правиле чтения. Вся статистика
-- (v15, v20, v21, v29, v30 и остальные) считает по тем креаторам, которых оставила RLS —
-- значит фильтр в политике прячет архивных разом из графиков, списков, «Лучших видео» и
-- перекрёстности. Функции архива ниже — `security definer`, они видят всех.
-- ⚠️ Сборщик ходит служебным ключом МИМО RLS: ему фильтр прописан явно (`sync.mjs`, `watch.mjs`).
--
-- ⚠️ Три старые строки `creators_archive` (@germesova_, @akulalizka, @mrbeast) остаются как
-- есть — данные по ним ушли каскадом ещё тогда (владелец: «пусть висят пустые, ничего
-- страшного»). Ради них живут прежние `restore_creator` (v25) и `purge_archived_creator`
-- (v31). Триггер, который писал те строки, снят: в архив теперь уводит отметка, а не удаление.

alter table public.creators
  add column archived_at       timestamptz,
  add column archived_by       uuid references auth.users (id) on delete set null,
  add column archived_by_login text not null default '',
  -- Пауза ставится ТОЛЬКО руками (владелец, 2026-09-15): сборщик сам за владельца не решает.
  add column sync_off          boolean not null default false;

create index creators_archived_idx on public.creators (archived_at) where archived_at is not null;

drop trigger creators_archive on public.creators;

-- ---------------------------------------------------------------------------------------
-- Чтение: архивных не показываем никому. Остальное — слово в слово как в v23.
-- ---------------------------------------------------------------------------------------

drop policy "sees visible creators" on public.creators;
create policy "sees visible creators" on public.creators for select to authenticated
  using (
    archived_at is null
    and (
      (select public.is_admin())
      or id in (select cm.creator_id from public.creator_managers cm where cm.manager_id = (select auth.uid()))
    )
  );

-- ---------------------------------------------------------------------------------------
-- Убрать в архив и вернуть — одна функция, `p_on` решает направление
-- ---------------------------------------------------------------------------------------

create function public.set_creator_archived(p_id uuid, p_on boolean)
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
    raise exception 'Убирать креатора в архив и возвращать может только администратор' using errcode = '42501';
  end if;

  if p_on then
    select p.login into who_login from public.profiles p where p.user_id = who;
    update public.creators
       set archived_at = now(), archived_by = who, archived_by_login = coalesce(who_login, 'система')
     where id = p_id;
  else
    update public.creators
       set archived_at = null, archived_by = null, archived_by_login = ''
     where id = p_id;
  end if;

  if not found then
    raise exception 'Такого креатора в базе нет' using errcode = 'P0001';
  end if;
  return p_id;
end;
$$;

-- security definer нужен потому, что правило чтения архивных уже не пропускает: вернуть
-- строку, которой не видишь, обычным update нельзя. Проверка прав — is_admin() первой строкой.
revoke execute on function public.set_creator_archived(uuid, boolean) from public, anon;
grant execute on function public.set_creator_archived(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------------------
-- Корзина в архиве: стереть насовсем вместе со всей историей
-- ---------------------------------------------------------------------------------------

create function public.purge_creator(p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  gone text;
begin
  if not (select public.is_admin()) then
    raise exception 'Удалить креатора насовсем может только администратор' using errcode = '42501';
  end if;

  -- Видео, снимки, комментарии, теги и привязки менеджеров уйдут каскадом (init.sql, v2).
  delete from public.creators where id = p_id returning handle into gone;
  if gone is null then
    raise exception 'Такого креатора в базе нет' using errcode = 'P0001';
  end if;
  return gone;
end;
$$;

revoke execute on function public.purge_creator(uuid) from public, anon;
grant execute on function public.purge_creator(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------
-- Список архива: карточки с отметкой + сколько истории за ними сохранено
-- ---------------------------------------------------------------------------------------

create function public.list_archive()
returns table (
  id uuid,
  platform text,
  handle text,
  display_name text,
  avatar_url text,
  profile_url text,
  added_at timestamptz,
  managers text[],
  deleted_at timestamptz,
  deleted_by_login text,
  videos bigint,
  comments bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  -- Админ — единственный, кто видит архив (как и прежняя политика "admin sees archive").
  select
    c.id, c.platform, c.handle, c.display_name, c.avatar_url, c.profile_url, c.added_at,
    coalesce((
      select array_agg(p.login order by p.login)
      from public.creator_managers cm
      join public.profiles p on p.user_id = cm.manager_id
      where cm.creator_id = c.id
    ), '{}'),
    c.archived_at,
    c.archived_by_login,
    (select count(*) from public.videos v where v.creator_id = c.id),
    (select count(*) from public.video_comments k join public.videos v on v.id = k.video_id where v.creator_id = c.id)
  from public.creators c
  where c.archived_at is not null
    and (select public.is_admin())
  order by c.archived_at desc;
$$;

revoke execute on function public.list_archive() from public, anon;
grant execute on function public.list_archive() to authenticated;
