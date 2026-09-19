-- Версия 37 (владелец, 2026-09-19): оплата креаторам.
--
-- Что считаем. За каждое видео креатору положены три части:
--   Base        — доллары за сам факт публикации;
--   Bonus       — доллары за тысячу просмотров, но только если просмотров не меньше
--                 Min Bonus Threshold, и только до Max Bonus Threshold;
--   Extra Bonus — разовая надбавка, если просмотров стало БОЛЬШЕ Max Bonus Threshold
--                 (ровно 100 000 — это ещё не надбавка, только потолок бонуса).
-- Просмотры берутся не текущие, а на отметке `публикация + Calculation Window`: платим за
-- первые трое суток, дальше видео живёт только в статистике.
--
-- 🔴 Снимка ровно на отметке не бывает — обход ходит два раза в сутки. Владелец, 2026-09-19:
-- берём ПЕРВЫЙ снимок на отметке или после неё («окно закрылось в обед — считаем по вечернему
-- обходу, ночью — по утреннему»). Пока такого снимка нет, сумма видео не окончательная.
--
-- 🔴 Видео, у которого внутри окна не было ни одного снимка, в деньги не идёт вовсе (владелец,
-- 2026-09-19: «первоначально не будем считать статистику, потом подумаем, что с ними сделать»).
-- Таких сейчас 20 из 36 — они вышли до того, как сборщик начал их снимать, и первый снимок
-- пришёл через 120–400 часов. В порог Videos Threshold они при этом входят: видео сделано.
--
-- Деньги считает САЙТ (`src/lib/payment.ts`), а не база: формула одна на весь проект, и
-- разъехаться двум её копиям нечем. База отдаёт только числа, которых у сайта нет, —
-- просмотры на отметке окна и был ли снимок внутри окна (`payment_stats`).
--
-- Доступ: только администратор (владелец, 2026-09-19: «сразу протестим сами, а потом дадим
-- доступ менеджеру»). Менеджер не видит ни ставок, ни выплат, ни документов.

-- ---------------------------------------------------------------------------------------
-- Ставки: своя строка на каждого креатора
-- ---------------------------------------------------------------------------------------
--
-- Общих ставок «на весь сайт» нет намеренно (владелец, 2026-09-19: «все личные у каждого
-- креатора»). Значения по умолчанию живут здесь, в `default` колонок: новый креатор получает
-- их триггером ниже, а дальше его строка правится отдельно от всех.

create table public.payment_rules (
  creator_id       uuid primary key references public.creators (id) on delete cascade,
  base             numeric(12,2) not null default 3.00,      -- Base, $ за опубликованное видео
  bonus            numeric(12,2) not null default 0.50,      -- Bonus, $ за 1000 просмотров
  min_bonus_views  integer       not null default 500,       -- Min Bonus Threshold, просмотры
  max_bonus_views  integer       not null default 100000,    -- Max Bonus Threshold, просмотры
  extra_bonus      numeric(12,2) not null default 15.00,     -- Extra Bonus, $ сверх потолка
  window_hours     integer       not null default 72,        -- Calculation Window, часы
  videos_threshold integer       not null default 4,         -- Videos Threshold, видео
  updated_at       timestamptz   not null default now(),
  updated_by       uuid references auth.users (id) on delete set null,
  constraint payment_rules_sane check (
    base >= 0 and bonus >= 0 and extra_bonus >= 0
    and min_bonus_views >= 0
    and max_bonus_views >= min_bonus_views
    and window_hours > 0
    and videos_threshold >= 0
  )
);

comment on table public.payment_rules is 'Ставки оплаты, своя строка на каждого креатора (v37). Значения по умолчанию — в default колонок.';
comment on column public.payment_rules.window_hours is 'Часы от публикации, за которые считаются просмотры для бонуса. Дальше видео идёт только в статистику.';
comment on column public.payment_rules.videos_threshold is 'Сколько видео креатор должен опубликовать, чтобы вообще начались выплаты. Видео без данных в окне тоже считаются.';

-- Всем, кто уже заведён.
insert into public.payment_rules (creator_id)
select c.id from public.creators c
on conflict (creator_id) do nothing;

-- И каждому новому. security definer — креатора заводит и сайт, и сборщик служебным ключом,
-- а строка ставок нужна одинаково в обоих случаях.
create function public.payment_rules_for_new_creator()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.payment_rules (creator_id) values (new.id)
  on conflict (creator_id) do nothing;
  return new;
end;
$$;

create trigger creators_payment_rules
  after insert on public.creators
  for each row execute function public.payment_rules_for_new_creator();

-- ---------------------------------------------------------------------------------------
-- Выплаты и что именно они закрыли
-- ---------------------------------------------------------------------------------------
--
-- Долг считается балансом (владелец, 2026-09-19): «сумма уходит из финального в выплачено».
-- Но одного баланса мало: ставку креатора можно поменять задним числом, и тогда уже оплаченные
-- видео молча подорожали бы. Поэтому платёж запоминает, какие видео он закрыл и почём
-- (`payment_videos`), а разница между расчётной и введённой суммой остаётся в балансе.

create table public.payments (
  id               bigint generated always as identity primary key,
  creator_id       uuid not null references public.creators (id) on delete cascade,
  paid_at          timestamptz not null default now(),
  amount           numeric(12,2) not null check (amount > 0),   -- сколько заплатил владелец
  covered_total    numeric(12,2) not null default 0,            -- на сколько было закрыто видео
  doc_path         text not null,                               -- ключ в бакете receipts
  doc_name         text not null default '',                    -- имя файла, каким его выбрали
  note             text not null default '',
  created_by       uuid references auth.users (id) on delete set null,
  created_by_login text not null default '',
  created_at       timestamptz not null default now()
);

create index payments_creator_idx on public.payments (creator_id, paid_at desc);

comment on table public.payments is 'Записанные выплаты креатору: сумма, документ, кто записал (v37).';

create table public.payment_videos (
  payment_id bigint not null references public.payments (id) on delete cascade,
  video_id   text   not null references public.videos (id) on delete cascade,
  base       numeric(12,2) not null default 0,
  bonus      numeric(12,2) not null default 0,
  extra      numeric(12,2) not null default 0,
  total      numeric(12,2) not null default 0,
  views      bigint,                                            -- просмотры на отметке окна
  primary key (payment_id, video_id)
);

-- Одно видео закрывается ровно одним платежом: без этого замок «оплатить дважды» держался бы
-- только на честности экрана, а строки в `payment_stats` задваивались бы соединением.
create unique index payment_videos_video_uniq on public.payment_videos (video_id);

comment on table public.payment_videos is 'Какие видео закрыл платёж и почём — суммы заморожены на момент выплаты (v37).';

-- ---------------------------------------------------------------------------------------
-- Документы выплат: приватный бакет
-- ---------------------------------------------------------------------------------------
--
-- В отличие от аватаров, публичным он быть не может: это платёжные документы. Читается
-- подписанной ссылкой, и только администратором. Тип файла любой — чек бывает и pdf, и снимком
-- экрана; потолок 20 МБ.

insert into storage.buckets (id, name, public, file_size_limit)
values ('receipts', 'receipts', false, 20971520)
on conflict (id) do nothing;

create policy "admin reads receipts"   on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and (select public.is_admin()));
create policy "admin uploads receipts" on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and (select public.is_admin()));
create policy "admin deletes receipts" on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and (select public.is_admin()));

-- ---------------------------------------------------------------------------------------
-- Доступ: всё про деньги видит только администратор
-- ---------------------------------------------------------------------------------------

alter table public.payment_rules  enable row level security;
alter table public.payments       enable row level security;
alter table public.payment_videos enable row level security;

create policy "admin reads rules"   on public.payment_rules for select to authenticated
  using ((select public.is_admin()));
create policy "admin writes rules"  on public.payment_rules for insert to authenticated
  with check ((select public.is_admin()));
create policy "admin updates rules" on public.payment_rules for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
-- Удаления строки ставок нет вовсе: она живёт ровно столько, сколько сам креатор.

create policy "admin reads payments"       on public.payments       for select to authenticated
  using ((select public.is_admin()));
create policy "admin reads payment videos" on public.payment_videos for select to authenticated
  using ((select public.is_admin()));
-- Пишет выплаты только `record_payment` — она security definer и спрашивает права сама.

-- ---------------------------------------------------------------------------------------
-- Числа для расчёта: по каждому видео — просмотры на отметке окна
-- ---------------------------------------------------------------------------------------
--
-- ⚠️ Берутся только НАШИ видео (`ours or watch`) — тот же охват, что «Только наши» на
-- дашборде (v22). Чужой ролик в аккаунте креатора денег не приносит и в порог не входит.
--
-- Что отдаёт функция:
--   views_window / window_at — первый снимок на отметке или после неё; null — окно ещё не
--     закрылось (или обход после него ещё не приходил), сумма видео не окончательная;
--   has_early — был ли снимок ВНУТРИ окна; false значит «мы не видели это видео вовремя»,
--     и в деньги оно не идёт;
--   views_now / now_at — последний известный снимок, для оценки незакрытых видео;
--   payment_id — каким платежом видео уже закрыто.

create function public.payment_stats(p_creator uuid default null, p_limit int default 2000)
returns table (
  video_id     text,
  creator_id   uuid,
  published_at timestamptz,
  caption      text,
  cover_url    text,
  url          text,
  gone_at      timestamptz,
  window_hours integer,
  mark_at      timestamptz,
  views_window bigint,
  window_at    timestamptz,
  has_early    boolean,
  views_now    bigint,
  now_at       timestamptz,
  payment_id   bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  with vids as (
    select
      v.id, v.creator_id, v.published_at, v.caption, v.cover_url, v.url, v.gone_at,
      coalesce(r.window_hours, 72) as window_hours,
      v.published_at + make_interval(hours => coalesce(r.window_hours, 72)) as mark_at
    from public.videos v
    join public.creators c on c.id = v.creator_id              -- RLS оставит видимых
    left join public.payment_rules r on r.creator_id = v.creator_id
    where v.published_at is not null
      and (v.ours or v.watch)
      and (p_creator is null or v.creator_id = p_creator)
  )
  select
    vids.id, vids.creator_id, vids.published_at, vids.caption, vids.cover_url, vids.url,
    vids.gone_at, vids.window_hours, vids.mark_at,
    w.views, w.taken_at,
    e.id is not null,
    n.views, n.taken_at,
    pv.payment_id
  from vids
  left join lateral (
    select s.views, s.taken_at
    from public.video_snaps s
    where s.video_id = vids.id and s.taken_at >= vids.mark_at
    order by s.taken_at asc limit 1
  ) w on true
  left join lateral (
    select s.id
    from public.video_snaps s
    where s.video_id = vids.id and s.taken_at <= vids.mark_at
    limit 1
  ) e on true
  left join lateral (
    select s.views, s.taken_at
    from public.video_snaps s
    where s.video_id = vids.id
    order by s.taken_at desc limit 1
  ) n on true
  left join public.payment_videos pv on pv.video_id = vids.id
  order by vids.published_at desc, vids.id desc
  limit greatest(p_limit, 0);
$$;

comment on function public.payment_stats(uuid, int)
  is 'Наши видео с просмотрами на отметке «публикация + окно» (первый снимок на/после неё) и отметкой, был ли снимок внутри окна. Деньги считает сайт (v37).';

revoke execute on function public.payment_stats(uuid, int) from anon;

-- ---------------------------------------------------------------------------------------
-- Записать выплату
-- ---------------------------------------------------------------------------------------
--
-- Одной транзакцией: строка платежа и замороженные суммы закрытых видео. Суммы приходят с
-- сайта — формула живёт там, и считать её второй раз здесь значило бы завести вторую правду.
-- Видео чужого креатора в список не попадёт: соединение с `videos` проверяет владельца.

create function public.record_payment(
  p_creator  uuid,
  p_amount   numeric,
  p_doc_path text,
  p_doc_name text,
  p_note     text,
  p_videos   jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  who       uuid := auth.uid();
  who_login text;
  new_id    bigint;
  covered   numeric(12,2);
begin
  if not (select public.is_admin()) then
    raise exception 'Only an administrator can record a payment' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'The paid amount must be greater than zero' using errcode = 'P0001';
  end if;
  if coalesce(p_doc_path, '') = '' then
    raise exception 'A payment needs its document' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.creators c where c.id = p_creator) then
    raise exception 'There is no such creator' using errcode = 'P0001';
  end if;

  select p.login into who_login from public.profiles p where p.user_id = who;

  insert into public.payments
    (creator_id, amount, covered_total, doc_path, doc_name, note, created_by, created_by_login)
  values
    (p_creator, p_amount, 0, p_doc_path, coalesce(p_doc_name, ''), coalesce(p_note, ''),
     who, coalesce(who_login, 'system'))
  returning id into new_id;

  -- ⚠️ «Покрыто» считается по строкам, которые ДЕЙСТВИТЕЛЬНО легли, а не по списку из
  -- запроса: видео, закрытое прежним платежом, второй раз не закрывается, и приписать его
  -- сумму второму платежу значило бы тихо занизить долг (проба 2026-09-19 — двойной щелчок
  -- по кнопке записывал вторую выплату «за то же самое»).
  with ins as (
    insert into public.payment_videos (payment_id, video_id, base, bonus, extra, total, views)
    select
      new_id, v.id,
      coalesce((x ->> 'base')::numeric, 0),
      coalesce((x ->> 'bonus')::numeric, 0),
      coalesce((x ->> 'extra')::numeric, 0),
      coalesce((x ->> 'total')::numeric, 0),
      nullif(x ->> 'views', '')::bigint
    from jsonb_array_elements(coalesce(p_videos, '[]'::jsonb)) as x
    join public.videos v on v.id = (x ->> 'video_id') and v.creator_id = p_creator
    on conflict (video_id) do nothing
    returning total
  )
  select coalesce(sum(total), 0) into covered from ins;

  update public.payments set covered_total = covered where id = new_id;

  return new_id;
end;
$$;

comment on function public.record_payment(uuid, numeric, text, text, text, jsonb)
  is 'Записывает выплату и замораживает суммы закрытых ею видео (v37). Только администратор.';

revoke execute on function public.record_payment(uuid, numeric, text, text, text, jsonb) from public, anon;
grant execute on function public.record_payment(uuid, numeric, text, text, text, jsonb) to authenticated;
