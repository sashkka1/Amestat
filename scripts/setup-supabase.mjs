// Подключение проекта Supabase одной командой: `npm run setup:supabase`.
//
// Читает .env.local. Обязательных значений три: адрес, публичный ключ, service_role.
// С ними скрипт кладёт ключи сборщику в Sashboard; всё остальное делает, если дали чем:
//   1. Миграции из supabase/migrations — с токеном (link + push) или с одним паролем
//      базы (push по адресу базы). Без того и другого — руками в SQL Editor.
//   2. Пользователь сайта в Auth + строка в public.owners — если дали почту и пароль.
//   3. Регистрация выключена, Site URL / Redirect URLs — если дали токен.
//   4. ../data/amestat.json для сборщика — если рядом лежит Sashboard.
// Что пропущено — перечисляется в конце как «руками в панели».
//
// Повторный запуск безопасен: накаченные миграции пропускаются, пользователь и строка
// owners не дублируются. Ничего не печатает из ключей.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(root, ".env.local");
const manual = [];

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
  if (!v) fail(`в .env.local пусто ${name} — это обязательное`);
  return v;
};
const maybe = (name) => env[name] || "";

const url = need("NEXT_PUBLIC_SUPABASE_URL").replace(/\/(rest\/v1\/?)?$/, "");
const anon = need("NEXT_PUBLIC_SUPABASE_ANON_KEY") || need("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
const service = need("SUPABASE_SERVICE_ROLE_KEY");
const dbPassword = maybe("SUPABASE_DB_PASSWORD");
const accessToken = maybe("SUPABASE_ACCESS_TOKEN");
const loginEmail = maybe("AMESTAT_LOGIN_EMAIL");
const loginPassword = maybe("AMESTAT_LOGIN_PASSWORD");
const siteUrl = maybe("AMESTAT_SITE_URL").replace(/\/?$/, "/");

const ref = new URL(url).hostname.split(".")[0];
if (!/^[a-z]{20}$/.test(ref)) fail(`не похоже на адрес проекта Supabase: ${url}`);
console.log(`проект ${ref}`);

// ---------------------------------------------------------------------------- CLI
function cli(args) {
  const isWin = process.platform === "win32";
  const res = spawnSync(isWin ? "supabase.exe" : "supabase", args, {
    cwd: root,
    stdio: "inherit",
    env: accessToken ? { ...process.env, SUPABASE_ACCESS_TOKEN: accessToken } : process.env,
    shell: isWin,
  });
  if (res.status !== 0) fail(`supabase ${args[0]} ${args[1] ?? ""} завершился с кодом ${res.status}`);
}

// 1. Миграции.
if (accessToken && dbPassword) {
  console.log("→ supabase link");
  cli(["link", "--project-ref", ref, "--password", dbPassword, "--yes"]);
  console.log("→ supabase db push");
  cli(["db", "push", "--password", dbPassword, "--yes"]);
} else if (dbPassword) {
  console.log("→ supabase db push (по паролю базы, без токена)");
  const dbUrl = `postgresql://postgres:${encodeURIComponent(dbPassword)}@db.${ref}.supabase.co:5432/postgres`;
  cli(["db", "push", "--db-url", dbUrl, "--yes"]);
} else {
  manual.push("Миграции: SQL Editor → выполнить по очереди supabase/migrations/*.sql (или дай SUPABASE_DB_PASSWORD — накачу сам)");
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

// Схема на месте? Без таблицы owners дальше идти некуда.
let schemaReady = false;
{
  const probe = await call("GET", `${url}/rest/v1/owners?select=user_id&limit=1`, undefined, adminHeaders);
  schemaReady = probe.status === 200;
  console.log(schemaReady ? "→ схема в базе есть" : `→ схемы в базе ещё нет (HTTP ${probe.status})`);
}

// 2. Пользователь сайта и замок owners.
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
  if (schemaReady) {
    const res = await call("POST", `${url}/rest/v1/owners?on_conflict=user_id`, { user_id: userId }, {
      ...adminHeaders,
      Prefer: "resolution=ignore-duplicates,return=minimal",
    });
    if (res.status < 200 || res.status >= 300) fail(`owners: HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    console.log("  вписан в owners");
  } else {
    manual.push(`Замок: после миграций — SQL Editor: insert into public.owners (user_id) select id from auth.users where email = '${loginEmail}';`);
  }
} else {
  manual.push("Пользователь: Authentication → Users → Add user (Auto confirm); затем SQL: insert into public.owners (user_id) select id from auth.users where email = '…'; (или дай AMESTAT_LOGIN_EMAIL и AMESTAT_LOGIN_PASSWORD)");
}

// 3. Регистрация и адреса сайта — только с токеном.
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
    manual.push(`Регистрация: не выключилась (HTTP ${res.status}) — Authentication → Sign In / Providers → Email → выключить Allow new users to sign up`);
  } else {
    console.log("  регистрация выключена" + (siteUrl ? `, Site URL ${siteUrl}` : ""));
  }
} else {
  manual.push("Регистрация: Authentication → Sign In / Providers → Email → выключить Allow new users to sign up; URL Configuration → Site URL и Redirect URLs = " + (siteUrl || "адрес сайта"));
}

// 4. Ключи сборщику в Sashboard.
{
  const hub = resolve(root, "..");
  if (existsSync(resolve(hub, "settings.gradle.kts"))) {
    const dataDir = resolve(hub, "data");
    mkdirSync(dataDir, { recursive: true });
    const file = resolve(dataDir, "amestat.json");
    writeFileSync(file, JSON.stringify({ url, serviceKey: service }, null, 2) + "\n");
    console.log(`→ ключи сборщика: ${file}`);
  } else {
    manual.push("Сборщик: адрес и service_role ввести в Sashboard → ⚙ → «amestat — сборщик»");
  }
}

if (manual.length > 0) {
  console.log("\nОсталось руками в панели Supabase:");
  for (const line of manual) console.log(`  • ${line}`);
}
console.log("\n✓ готово. Проверка: npm run dev → http://localhost:3000/login/" + (loginEmail ? ` → вход ${loginEmail}` : ""));
void anon;
