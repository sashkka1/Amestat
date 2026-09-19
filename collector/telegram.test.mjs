// Тесты ночной задержки писем в Telegram: `npm test` в collector.
// Ночь — с 23:00 до 07:00 по Минску (владелец, 2026-09-19). Минск живёт в UTC+3 без перевода
// часов, поэтому моменты ниже заданы в UTC: 20:00Z — это 23:00 по Минску, 04:00Z — 07:00.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isNight } from "./telegram.mjs";
import { nightDigestRu } from "./telegram-ru.mjs";

const utc = (iso) => new Date(iso);

test("night is 23:00–07:00 in Minsk, borders included on the right side", () => {
  assert.equal(isNight(utc("2026-09-19T19:59:00Z")), false, "22:59 — still evening");
  assert.equal(isNight(utc("2026-09-19T20:00:00Z")), true, "23:00 — night starts");
  assert.equal(isNight(utc("2026-09-19T23:30:00Z")), true, "02:30 — deep night");
  assert.equal(isNight(utc("2026-09-20T03:59:00Z")), true, "06:59 — still night");
  assert.equal(isNight(utc("2026-09-20T04:00:00Z")), false, "07:00 — morning, the queue goes out");
  assert.equal(isNight(utc("2026-09-20T12:00:00Z")), false, "15:00 — day");
});

test("the morning digest puts every held message in, with its Minsk time", () => {
  const parts = nightDigestRu([
    { at: "2026-09-19T23:49:00Z", text: "first" },
    { at: "2026-09-20T00:17:00Z", text: "second" },
  ]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].count, 2);
  assert.match(parts[0].text, /накопилось сообщений: 2/);
  assert.match(parts[0].text, /02:49\nfirst/);
  assert.match(parts[0].text, /03:17\nsecond/);
});

test("a long night is split into parts under the limit, counts add up", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ at: "2026-09-20T00:00:00Z", text: "x".repeat(900) + i }));
  const parts = nightDigestRu(items, { max: 3500 });
  assert.ok(parts.length > 1, "more than one part");
  for (const p of parts) assert.ok(p.text.length <= 3500, `part of ${p.text.length} chars is over the limit`);
  assert.equal(parts.reduce((n, p) => n + p.count, 0), 12, "no message is lost between parts");
});

test("an empty queue gives nothing to send", () => {
  assert.deepEqual(nightDigestRu([]), []);
  assert.deepEqual(nightDigestRu(null), []);
});
