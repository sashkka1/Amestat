// Подключение проекта Supabase одной командой: `npm run setup:supabase`.
//
// Читает .env.local и делает всё, что иначе пришлось бы кликать в панели:
//   1. supabase link + db push — накатывает миграции из supabase/migrations.
//   2. Заводит пользователя сайта в Auth (AMESTAT_LOGIN_EMAIL / PASSWORD), если его нет.
//   3. Вписывает его в public.owners — без этого RLS не отдаст ни строки.
//   4. Выключает регистрацию и ставит Site URL / Redirect URLs на адрес Pages.
//   5. Кладёт адрес и service_role в ../data/amestat.json для сборщика в Sashboard —
//      только если скрипт запущен внутри хаба (рядом лежит его settings.gradle.kts).
//
// Повторный запуск безопасен: миграции уже накаченные пропускаются, пользователь и
// строка owners не дублируются. Ничего не печатает из ключей.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env.local");

function fail(text) {
  console.error(`✗ ${text}`);
  process.exit(1);
}

function readEnv(path) {
  if (!existsSync(path)) fail(`нет ${path} — скопируй .env.local.example и заполни`);
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = readEnv(envPath);
const need = (name) => {
  const v = env[name];
  if (!v) fail(`в .env.local пусто ${name}`);
  return v;
};

// Обязательных три: без них не работает ни сайт, ни сборщик. Остальное — замена кликам
// в панели: пусто — шаг пропускается, и в конце печатается, что сделать руками.
const url = need("NEXT_PUBLIC_SUPABASE_URL").replace(/\/$/, "");
const anon = need("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const service = need("SUPABASE_SERVICE_ROLE_KEY");
const dbPassword = env.SUPABASE_DB_PASSWORD || "";
const accessToken = env.SUPABASE_ACCESS_TOKEN || "";
const loginEmail = env.AMESTAT_LOGIN_EMAIL || "";
const loginPassword = env.AMESTAT_LOGIN_PASSWORD || "";
const siteUrl = (env.AMESTAT_SITE_URL || "").replace(/\/?$/, "/");

const ref = new URL(url).hostname.split(".")[0];
if (!/^[a-z]{20}$/.test(ref)) fail(`не похоже на адрес проекта Supabase: ${url}`);
console.log(`проект ${ref}`);

/** Что осталось сделать руками — печатается в конце одним списком. */
const manual = [];

// ---------------------------------------------------------------------------- CLI
function cli(args) {
  const isWin = process.platform === "win32";
  const res = spawnSync(isWin ? "supabase.exe" : "supabase", args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: accessToken },
    shell: isWin,
  });
  if (res.status !== 0) fail(`supabase ${args[0]} ${args[1] ?? ""} завершился с кодом ${res.status}`);
}

// 1. Миграции — нужны токен и пароль базы. Нет их — SQL вставляется в панели руками.
if (dbPassword && accessToken) {
  console.log("→ supabase link");
  cli(["link", "--project-ref", ref, "--password", dbPassword, "--yes"]);
  console.log("→ supabase db push");
  cli(["db", "push", "--password", dbPassword, "--yes"]);
} else {
  console.log("→ миграции: пропущено (нет SUPABASE_ACCESS_TOKEN и/или SUPABASE_DB_PASSWORD)");
  manual.push(
    "Миграции: панель → SQL Editor → вставить и выполнить по очереди файлы supabase/migrations/*.sql (по порядку имён).",
  );
}

// ---------------------------------------------------------------------------- HTTP
async function call(method, target, body, headers) {
  const res = await fetch(target, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* не JSON — оставим текст */ }
  return { status: res.status, json, text };
}

// `Bearer` — только для ключа-JWT (старый `service_role`, начинается с `eyJ`); новые
// `sb_secret_…` идут одним заголовком `apikey`.
const adminHeaders = service.startsWith("eyJ")
  ? { apikey: service, Authorization: `Bearer ${service}` }
  : { apikey: service };

// 2. Пользователь сайта и 3. замок owners — нужны почта и пароль. Нет их — в панели руками.
if (loginEmail && loginPassword) {
  console.log("→ пользователь сайта");
  let userId = null;
  const created = await call("POST", `${url}/auth/v1/admin/users`, {
    email: loginEmail,
    password: loginPassword,
    email_confirm: true,
  }, adminHeaders);
  if (created.status === 200 || created.status === 201) {
    userId = created.json?.id ?? null;
    console.log("  заведён");
  } else {
    // Уже есть — найдём. Пароль при этом не меняем: это решение владельца, а не скрипта.
    const list = await call("GET", `${url}/auth/v1/admin/users?page=1&per_page=1000`, undefined, adminHeaders);
    const found = (list.json?.users ?? []).find((u) => (u.email ?? "").toLowerCase() === loginEmail.toLowerCase());
    if (!found) fail(`пользователь не создался (HTTP ${created.status}: ${created.text.slice(0, 200)}) и не найден`);
    userId = found.id;
    console.log("  уже был — оставлен как есть");
  }

  console.log("→ owners");
  const res = await call("POST", `${url}/rest/v1/owners?on_conflict=user_id`, { user_id: userId }, {
    ...adminHeaders,
    Prefer: "resolution=ignore-duplicates,return=minimal",
  });
  if (res.status < 200 || res.status >= 300) fail(`owners: HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  console.log("  вписан");
} else {
  console.log("→ пользователь сайта: пропущено (нет AMESTAT_LOGIN_EMAIL / AMESTAT_LOGIN_PASSWORD)");
  manual.push(
    "Пользователь: Authentication → Users → Add user (почта, пароль, Auto confirm).",
    "Замок: SQL Editor → insert into public.owners (user_id) select id from auth.users where email = '<почта>';",
  );
}

// 4. Регистрация выключена, адреса сайта — нужен личный токен. Нет — тумблер в панели.
if (accessToken) {
  console.log("→ настройки Auth");
  const body = { disable_signup: true };
  if (siteUrl) {
    body.site_url = siteUrl;
    body.uri_allow_list = `${siteUrl},${siteUrl}login/,http://localhost:3000/,http://localhost:3000/login/`;
  }
  const res = await call("PATCH", `https://api.supabase.com/v1/projects/${ref}/config/auth`, body, {
    Authorization: `Bearer ${accessToken}`,
  });
  if (res.status < 200 || res.status >= 300) {
    console.warn(`  ⚠️ не удалось (HTTP ${res.status}: ${res.text.slice(0, 200)})`);
    manual.push("Регистрация: Authentication → Sign In / Providers → Email → выключить Allow new users to sign up.");
  } else {
    console.log("  регистрация выключена" + (siteUrl ? `, Site URL ${siteUrl}` : ""));
  }
} else {
  console.log("→ настройки Auth: пропущено (нет SUPABASE_ACCESS_TOKEN)");
  manual.push(
    "Регистрация: Authentication → Sign In / Providers → Email → выключить Allow new users to sign up.",
    `Адрес сайта: Authentication → URL Configuration → Site URL и Redirect URLs = ${siteUrl || "адрес Pages"}`,
  );
}

// 5. Ключи сборщику в Sashboard.
{
  const hub = resolve(root, "..");
  if (existsSync(resolve(hub, "settings.gradle.kts"))) {
    const dataDir = resolve(hub, "data");
    mkdirSync(dataDir, { recursive: true });
    const file = resolve(dataDir, "amestat.json");
    writeFileSync(file, JSON.stringify({ url, serviceKey: service }, null, 2) + "\n");
    console.log(`→ ключи сборщика: ${file}`);
  } else {
    console.log("→ Sashboard рядом не найден — адрес и service_role введи в ⚙ руками");
  }
}

if (manual.length > 0) {
  console.log("\nОсталось руками в панели Supabase:");
  for (const line of manual) console.log(`  • ${line}`);
}
console.log("\n✓ готово. Проверка: npm run dev → http://localhost:3000/login/" + (loginEmail ? ` → вход ${loginEmail}` : ""));
void anon;
