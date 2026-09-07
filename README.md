# Amestat

Админка для мониторинга креаторов TikTok: список с тегами, карточка креатора со статистикой за срок, сравнение видео с медианой аккаунта. Один пользователь — владелец.

Сайт — **статика на GitHub Pages**, сервера нет: страницы ходят в Supabase прямо из браузера (`supabase-js`, публичный ключ), доступ к данным решает RLS. Данные собирает сборщик в Sashboard и пишет в ту же базу.

## Переменные окружения

| Имя | Что это |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | адрес проекта Supabase (Project Settings → API) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | публичный ключ: новый publishable (`sb_publishable_…`) или старый anon (`eyJ…`); подходит и `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` |
| `NEXT_PUBLIC_BASE_PATH` | подпуть сайта. Локально пусто; на GitHub Pages workflow сам ставит `/<имя репозитория>` |

Все три вшиваются в сборку — менять их можно только пересборкой.

## Локально

```
cp .env.local.example .env.local   # подставить адрес и ключ
npm install
npm run dev                        # http://localhost:3000/
npm run lint && npm run build      # статика в out/
```

## База — одной командой

1. В Supabase создать проект (регион ближе к дому).
2. Заполнить `.env.local` (шаблон — `.env.local.example`). **Обязательных три:** адрес проекта, публичный ключ, ключ `service_role`. Остальное по желанию: личный токен и пароль базы (тогда скрипт сам накатит миграции и выключит регистрацию), почта и пароль входа (тогда скрипт сам заведёт пользователя и замок).
3. `npm run setup:supabase`. Чего скрипту не дали — он пропустит и в конце перечислит, что докликать в панели.

Скрипт `scripts/setup-supabase.mjs` накатывает миграции из `supabase/migrations/` (`supabase link` + `db push` с токеном из `.env.local`, без `supabase login`), заводит пользователя сайта, вписывает его в `owners`, выключает регистрацию, ставит Site URL и Redirect URLs, а если рядом лежит Sashboard — кладёт адрес и `service_role` в его `data/amestat.json` для сборщика. Повторный запуск безопасен.

**Замок на пользователя.** Одной роли `authenticated` для доступа мало: политики RLS пускают только тех, кто записан в таблицу `owners` (миграция `20260907153535_owners.sql`). Скрипт делает это сам; руками — в SQL Editor панели:

```sql
insert into public.owners (user_id) select id from auth.users where email = 'почта@пользователя';
```

Без этой строки вход пройдёт, а списки останутся пустыми: база отдаст ноль строк, не ошибку.

Руками вместо скрипта: `supabase login`, `supabase link --project-ref <ref>`, `supabase db push`; пользователь — Authentication → Users → «Add user» («Auto confirm»); регистрация — Sign In / Providers → Email → выключить **Allow new users to sign up**.

## GitHub Pages

1. Репозиторий на GitHub, ветка `main`. Workflow `.github/workflows/pages.yml` при каждом push собирает сайт и выкладывает `out/`.
2. Settings → Pages → Source: **GitHub Actions**.
3. Settings → Secrets and variables → Actions → вкладка **Variables** → добавить `NEXT_PUBLIC_SUPABASE_URL` и `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Это публичные значения, в секреты их прятать не нужно.
4. Адрес сайта: `https://<логин>.github.io/<репозиторий>/`. Подпуть workflow берёт из имени репозитория сам.
5. В Supabase → Authentication → URL Configuration добавить этот адрес в **Site URL** и в **Redirect URLs** — иначе ссылки из писем восстановления пароля поведут не туда.

`public/.nojekyll` обязателен: без него GitHub Pages не отдаёт папку `_next/`.

Файл `.env.local` в репозиторий не идёт (`.gitignore`).
