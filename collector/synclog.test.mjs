// Живой журнал обхода (`sync_log`, v16): чистые куски — уровень строки и её вид в таблице.
// База здесь не трогается вовсе.

import { test } from "node:test";
import assert from "node:assert/strict";
import { levelOf, logRow } from "./synclog.mjs";

test("a creator error and a run failure are error", () => {
  assert.equal(levelOf("  error: TikTok returned no list (address throttling; profile says 214 videos)"), "error");
  assert.equal(levelOf("the run was interrupted: fetch failed"), "error");
  assert.equal(levelOf("the run did not start: HTTP 503"), "error");
});

test("notices, waits and workarounds are warn", () => {
  assert.equal(levelOf("notices (3) — message to the owner: …"), "warn");
  assert.equal(levelOf("[tt] waiting out the TikTok pause until 13:24 (6 launches per 15 min)"), "warn");
  assert.equal(levelOf("  images: avatar ok, covers rehosted 0, failed 2"), "warn");
});

test("the ordinary course of things is info", () => {
  assert.equal(levelOf("[ig] @julia.snkvch (instagram)"), "info");
  assert.equal(levelOf("  done: videos 12, followers 4310"), "info");
  assert.equal(levelOf("run #57 (manual, all, depth week, comments yes, replies yes)"), "info");
});

test("zero counters in summary lines do not raise the level", () => {
  // Прогон 2026-09-09 по @julia.snkvch: эти три строки уезжали в журнал как warn зря.
  assert.equal(levelOf("[ig]   images: avatar ok, covers rehosted 0, failed 0"), "info");
  assert.equal(levelOf("[ig] extra requests trimmed 54, let through 0"), "info");
  assert.equal(levelOf("[ig]   pinned skipped: 0"), "info");
  assert.equal(levelOf("  comments: videos 3, collected 41 (replies 7), failed 0"), "info");
  assert.equal(levelOf("  comments: videos 3, collected 41 (replies 7), failed 2"), "warn", "but two that did not work out are news");
});

test("a lane line lands in the table with its platform, creator and level", () => {
  const row = logRow("[tt]   error: the video list is empty", { runId: 57, source: "browser", handle: "@toplombard_warszaw" });
  assert.equal(row.run_id, 57);
  assert.equal(row.source, "browser");
  assert.equal(row.creator_handle, "toplombard_warszaw", "\"@\" does not go into the database");
  assert.equal(row.level, "error");
  assert.equal(row.text, "[tt]   error: the video list is empty", "the lane prefix stays in the text");
});

test("a line about the run as a whole — source system, no creator; provider columns empty", () => {
  const row = logRow("run #57 finished", { runId: 57 });
  assert.equal(row.source, "system");
  assert.equal(row.creator_handle, null);
  assert.equal(row.account, undefined, "providers are postponed — we do not fill the column at all");
  assert.equal(row.units_spent, undefined);
});

test("a foreign source does not pass, the level can be set by hand", () => {
  const row = logRow("slot 13:00 skipped: there was already a run over everyone today at 11:42", { source: "ensembledata", level: "info" });
  assert.equal(row.source, "system", "the collector only ever has browser and system");
  assert.equal(row.level, "info", "\"skipped\" on its own would pull towards warn — here it is news, not trouble");
  assert.equal(row.run_id, null, "a line outside a run");
});
