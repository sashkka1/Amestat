// Тесты закрытия окна расчёта: `npm test` в collector.
// Проверяется только чистая часть — группировка строк базы в заходы.

import { test } from "node:test";
import assert from "node:assert/strict";
import { dueRuns, RETRY_MS } from "./window.mjs";

const row = (creator, video, mark, handle = creator) => ({
  creator_id: creator,
  handle,
  platform: "tiktok",
  video_id: video,
  mark_at: mark,
});

test("empty input gives no runs", () => {
  assert.deepEqual(dueRuns([]), []);
  assert.deepEqual(dueRuns(null), []);
});

test("two videos of one creator are closed by ONE run", () => {
  const runs = dueRuns([
    row("c1", "v1", "2026-09-19T10:00:00Z"),
    row("c1", "v2", "2026-09-19T12:00:00Z"),
  ]);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].creatorId, "c1");
  assert.equal(runs[0].videos, 2);
  // Отметка захода — самая старая: она дольше всех ждёт.
  assert.equal(runs[0].markAt, "2026-09-19T10:00:00Z");
});

test("creators go oldest mark first", () => {
  const runs = dueRuns([
    row("c2", "v2", "2026-09-19T12:00:00Z"),
    row("c1", "v1", "2026-09-19T08:00:00Z"),
    row("c3", "v3", "2026-09-19T10:00:00Z"),
  ]);
  assert.deepEqual(runs.map((r) => r.creatorId), ["c1", "c3", "c2"]);
});

test("the queue is cut by the limit — the rest waits for the next check", () => {
  const rows = ["c1", "c2", "c3", "c4"].map((c, i) => row(c, `v${i}`, `2026-09-19T0${i}:00:00Z`));
  assert.deepEqual(dueRuns(rows, 2).map((r) => r.creatorId), ["c1", "c2"]);
  assert.equal(dueRuns(rows, 0).length, 0);
  assert.equal(dueRuns(rows).length, 3, "by default no more than three at a time");
});

test("a row without a creator is skipped, not crashed on", () => {
  const runs = dueRuns([{ video_id: "v" }, row("c1", "v1", "2026-09-19T10:00:00Z")]);
  assert.deepEqual(runs.map((r) => r.creatorId), ["c1"]);
});

test("a creator already tried waits an hour — no loop of failed runs every five minutes", () => {
  const rows = [row("c1", "v1", "2026-09-19T10:00:00Z"), row("c2", "v2", "2026-09-19T11:00:00Z")];
  const now = Date.parse("2026-09-19T12:00:00Z");
  const tried = new Map([["c1", now - 10 * 60_000]]);
  assert.deepEqual(dueRuns(rows, 3, { tried, now }).map((r) => r.creatorId), ["c2"], "tried 10 min ago — skipped");
  const later = now + RETRY_MS;
  assert.deepEqual(dueRuns(rows, 3, { tried, now: later }).map((r) => r.creatorId), ["c1", "c2"], "an hour later — back in the queue");
});
