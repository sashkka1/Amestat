// Разовый обход руками:
//   node run.mjs                                        — все креаторы, весь список видео
//   node run.mjs --creator <uuid>                       — один
//   node run.mjs --depth week                           — только видео за последние 7 дней
//   node run.mjs --failed-only                          — только те, у кого осталась ошибка
//   node run.mjs --trigger schedule|catchup|manual|retry — чем помечен обход (по умолчанию manual)
//
// Печатает ход дела построчно и завершается кодом 0 (все собрались) или 1 (кто-то нет).

import { runSync } from "./sync.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);

if (has("--help") || has("-h")) {
  console.log("node run.mjs [--creator <uuid>] [--depth all|week] [--failed-only] [--trigger manual|schedule|catchup|retry]");
  process.exit(0);
}

const creatorId = opt("--creator");
const failedOnly = has("--failed-only");
const trigger = opt("--trigger", "manual");
if (!["manual", "schedule", "catchup", "retry"].includes(trigger)) {
  console.error(`✗ --trigger бывает только manual, schedule, catchup или retry, а не «${trigger}»`);
  process.exit(2);
}
const depth = opt("--depth", "all");
if (!["all", "week"].includes(depth)) {
  console.error(`✗ --depth бывает только all или week, а не «${depth}»`);
  process.exit(2);
}

const started = Date.now();
let result;
try {
  result = await runSync({ trigger, creatorId, failedOnly, depth, onLog: (line) => console.log(line) });
} catch (e) {
  // Сюда попадает только то, что случилось до первой строки в базе (например, нет .env.local).
  console.error(`✗ ${String(e?.message ?? e).split("\n")[0]}`);
  process.exit(1);
}

const seconds = ((Date.now() - started) / 1000).toFixed(0);
console.log(
  `\n${result.ok ? "✓" : "✗"} обход #${result.runId ?? "?"}: собрано ${result.done}, с ошибкой ${result.failed}, за ${seconds} с` +
  (result.error ? `\n  первая ошибка: ${result.error}` : ""),
);
process.exit(result.ok ? 0 : 1);
