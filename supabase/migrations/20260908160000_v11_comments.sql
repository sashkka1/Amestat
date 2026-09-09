-- Версия 11 (2026-09-08): комментарии к видео — не только число, но и сами тексты
-- (владелец: «коменты тоже нужно собирать, и количество, и сами»).
--
-- Число комментариев уже лежит в снимках (video_snaps.comments). Тексты — отдельной таблицей:
-- одна строка на комментарий площадки, повторный обход обновляет лайки и last_seen_at.
-- Пишет только сборщик (service_role), сайт читает то, что пускает can_see_creator через видео.

create table public.video_comments (
  id            text not null,                                              -- id комментария на площадке
  video_id      text not null references public.videos (id) on delete cascade,
  parent_id     text,                                                       -- ответ на комментарий: id родителя, у корневых null
  author_handle text not null default '',                                   -- @имя автора
  author_name   text not null default '',                                   -- отображаемое имя автора
  text          text not null default '',
  likes         integer,
  replies       integer,                                                    -- число ответов у корневого комментария
  created_at    timestamptz,                                                -- когда написан на площадке
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  primary key (video_id, id)
);

comment on table public.video_comments is 'Комментарии к видео с площадок. Пишет сборщик, читают вошедшие по видимости креатора.';

create index video_comments_video_created_idx on public.video_comments (video_id, created_at desc);
create index video_comments_video_likes_idx   on public.video_comments (video_id, likes desc);

alter table public.video_comments enable row level security;

create policy "sees visible comments" on public.video_comments
  for select to authenticated
  using (exists (select 1 from public.videos v where v.id = video_id and public.can_see_creator(v.creator_id)));

-- Когда комментарии этого видео снимались последний раз: сборщик решает, кого обходить, сайт
-- показывает свежесть списка.
alter table public.videos add column comments_synced_at timestamptz;

comment on column public.videos.comments_synced_at is 'Последний снятый список комментариев (тексты); null — ещё не снимались.';
