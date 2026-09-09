// Живой журнал обхода (`sync_log`, v16): чистые куски — уровень строки и её вид в таблице.
// База здесь не трогается вовсе.

import { test } from "node:test";
import assert from "node:assert/strict";
import { levelOf, logRow } from "./synclog.mjs";

test("ошибка креатора и беда обхода — это error", () => {
  assert.equal(levelOf("  ошибка: TikTok не отдал список (защита по адресу; по профилю 214 видео)"), "error");
  assert.equal(levelOf("обход прерван: fetch failed"), "error");
  assert.equal(levelOf("обход не начался: HTTP 503"), "error");
});

test("замечания, ожидания и обходные пути — это warn", () => {
  assert.equal(levelOf("замечания (3) — сообщение владельцу: …"), "warn");
  assert.equal(levelOf("[tt] ждём паузу TikTok до 13:24 (6 запусков за 15 мин)"), "warn");
  assert.equal(levelOf("  картинки: аватар ок, обложек переложено 0, не вышло 2"), "warn");
});

test("обычный ход дела — info", () => {
  assert.equal(levelOf("[ig] @julia.snkvch (instagram)"), "info");
  assert.equal(levelOf("  готово: видео 12, подписчиков 4310"), "info");
  assert.equal(levelOf("обход #57 (manual, все, глубина неделя, комментарии да, ветки да)"), "info");
});

test("нулевые счётчики в итоговых строках уровня не поднимают", () => {
  // Прогон 2026-09-09 по @julia.snkvch: эти три строки уезжали в журнал как warn зря.
  assert.equal(levelOf("[ig]   картинки: аватар ок, обложек переложено 0, не вышло 0"), "info");
  assert.equal(levelOf("[ig] лишних запросов отсечено 54, пропущено 0"), "info");
  assert.equal(levelOf("[ig]   закреплённых пропущено: 0"), "info");
  assert.equal(levelOf("  комментарии: видео 3, собрано 41 (ответов 7), не вышло 0"), "info");
  assert.equal(levelOf("  комментарии: видео 3, собрано 41 (ответов 7), не вышло 2"), "warn", "а вот два невышедших — уже новость");
});

test("строка полосы ложится в таблицу с площадкой, креатором и уровнем", () => {
  const row = logRow("[tt]   ошибка: список видео пуст", { runId: 57, source: "browser", handle: "@toplombard_warszaw" });
  assert.equal(row.run_id, 57);
  assert.equal(row.source, "browser");
  assert.equal(row.creator_handle, "toplombard_warszaw", "«@» в базу не идёт");
  assert.equal(row.level, "error");
  assert.equal(row.text, "[tt]   ошибка: список видео пуст", "префикс полосы остаётся в тексте");
});

test("строка обхода в целом — source system, креатора нет; провайдерские колонки пустые", () => {
  const row = logRow("обход #57 закончен", { runId: 57 });
  assert.equal(row.source, "system");
  assert.equal(row.creator_handle, null);
  assert.equal(row.account, undefined, "провайдеры отложены — колонку не заполняем вовсе");
  assert.equal(row.units_spent, undefined);
});

test("чужой source не проходит, уровень можно задать руками", () => {
  const row = logRow("слот 13:00 пропущен: сегодня уже был обход по всем в 11:42", { source: "ensembledata", level: "info" });
  assert.equal(row.source, "system", "у сборщика бывает только browser и system");
  assert.equal(row.level, "info", "«пропущен» само по себе тянуло бы на warn — здесь это новость, а не беда");
  assert.equal(row.run_id, null, "строка вне обхода");
});
