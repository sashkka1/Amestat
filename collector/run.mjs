// Разовый обход руками:
//   node run.mjs                                        — все креаторы, весь список видео
//   node run.mjs --creator <uuid>                       — один
//   node run.mjs --depth week                           — только видео за последние 7 дней
//   node run.mjs --depth month                          — за последние 30 дней
//   node run.mjs --depth range --from 2026-09-01 --to 2026-09-09
//                                                       — за выбранный период; даты МЕСТНЫЕ и
//                                                         берутся целыми сутками (--from с
//                                                         начала дня, --to по конец дня)
//   node run.mjs --failed-only                          — только те, у кого осталась ошибка
//   node run.mjs --no-comments                          — не снимать тексты комментариев вовсе
//   node run.mjs --no-replies                           — снять корневые, ветки ответов не раскрывать
//   node run.mjs --only-ours                            — охват «только наши»: листать список лишь
//                                                         до тех пор, пока не встретятся все наши
//                                                         и жёлтые видео креатора
//   node run.mjs --trigger schedule|catchup|manual|retry — чем помечен обход (по умолчанию manual)
//
// Печатает ход дела построчно и завершается кодом 0 (все собрались) или 1 (кто-то нет).

import { runSync } from "./sync.mjs";
import { dayRange } from "./scope.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);

if (has("--help") || has("-h")) {
  console.log("node run.mjs [--creator <uuid>] [--depth all|week|month|range] [--from ГГГГ-ММ-ДД --to ГГГГ-ММ-ДД] [--only-ours] [--failed-only] [--no-comments] [--no-replies] [--all-videos] [--trigger manual|schedule|catchup|retry]");
  process.exit(0);
}

const creatorId = opt("--creator");
const failedOnly = has("--failed-only");
// Оба выключателя — то же, что галочки в матрице обновления на сайте (`sync_requests`).
// `--no-replies` отменяет только клики по веткам: даровые ответы приезжают внутри корневых.
const comments = !has("--no-comments");
const replies = !has("--no-replies");
// `--all-videos` — галочка «Комментарии и у не наших видео»: обычно тексты снимаются только у наших.
const allVideos = has("--all-videos");
// `--only-ours` — охват из матрицы обновления: 'ours' вместо 'all' (миграция v17).
const videos = has("--only-ours") ? "ours" : "all";
const trigger = opt("--trigger", "manual");
if (!["manual", "schedule", "catchup", "retry"].includes(trigger)) {
  console.error(`✗ --trigger бывает только manual, schedule, catchup или retry, а не «${trigger}»`);
  process.exit(2);
}
const depth = opt("--depth", "all");
if (!["all", "week", "month", "range"].includes(depth)) {
  console.error(`✗ --depth бывает только all, week, month или range, а не «${depth}»`);
  process.exit(2);
}
// Края периода. Даты местные и целыми сутками — разбирает чистая `dayRange` (`scope.mjs`),
// чтобы «с 1 по 9» не теряло девятое число и чтобы её проверяли тесты.
// ⚠️ Ругаемся тут, а не молча опускаемся до «всё»: человек в командной строке просил период,
// и подменённая глубина выглядела бы как исправная работа.
let depthFrom = null, depthTo = null;
if (depth === "range") {
  const range = dayRange(opt("--from"), opt("--to"));
  if (!range) {
    console.error("✗ --depth range требует --from и --to (ГГГГ-ММ-ДД, начало периода раньше конца)");
    process.exit(2);
  }
  depthFrom = range.from;
  depthTo = range.to;
} else if (opt("--from") || opt("--to")) {
  console.error(`✗ --from и --to бывают только у --depth range, а глубина здесь «${depth}»`);
  process.exit(2);
}

const started = Date.now();
let result;
try {
  result = await runSync({ trigger, creatorId, failedOnly, depth, depthFrom, depthTo, videos, comments, replies, allVideos, onLog: (line) => console.log(line) });
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
