// Правила тишины: когда владельцу пишем, а когда молчим.
//
// Проверяется только чистая половина `notices.mjs` — расчёты без таймеров, файлов и Telegram.
// Часы поддельные: во все функции время передаётся числом, поэтому тест не ждёт ни секунды.
//
// Откуда правила: 2026-09-08, вечер — ноутбук проснулся в 19:04, и за 12 минут владелец получил
// семь сообщений (мигание Realtime, одиночный `fetch failed`, повторно назначенный повтор, два
// письма об одном обходе). Каждый тест ниже — про одно из этих семи.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMessage, dataLost, sendAt, streak, sleepGap, isWarm, realtimeStep, realtimeDown, squashKnown,
  sessionWatch, splitVanished, forgetReturned, shortOnce,
  DB_STREAK, REALTIME_DOWN_MS, WARMUP_MS, JUMP_MS, SAME_ERROR_MS,
} from "./notices.mjs";

const MIN = 60_000;
const T0 = Date.parse("2026-09-08T19:05:00");

// ------------------------------------------------------------------ сообщение
test("buildMessage: header, coded lines and a repeat counter", () => {
  const text = buildMessage("header", [
    { code: "creator", text: "@a: profile not found" },
    { code: "db", text: "was not saved", count: 3 },
  ]);
  assert.equal(text, "header\n[creator] @a: profile not found\n[db] was not saved (×3)");
});

test("buildMessage: the overflow is not lost silently, it is counted", () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ code: "creator", text: `line ${i} `.repeat(10) }));
  const text = buildMessage("header", items, 300);
  assert.ok(text.length <= 300, `length ${text.length}`);
  assert.match(text.split("\n").at(-1), /^… and \d+ more$/);
});

// ------------------------------------------------------------------ пачка резидентских писем
test("sendAt: the first message goes no sooner than a minute after the first notice", () => {
  assert.equal(sendAt(T0, { lastSentAt: 0, firstQueuedAt: T0 }), T0 + MIN);
});

test("sendAt: the next message goes no sooner than 5 minutes after the previous one", () => {
  // Замечание легло сразу после письма: минуты сбора мало, ждём конца пятиминутного окна.
  const due = sendAt(T0 + 10_000, { lastSentAt: T0, firstQueuedAt: T0 + 10_000 });
  assert.equal(due, T0 + 5 * MIN);
});

test("sendAt: a notice at the end of the window waits only the gathering minute", () => {
  const late = T0 + 5 * MIN;   // окно уже почти истекло
  assert.equal(sendAt(late, { lastSentAt: T0, firstQueuedAt: late }), late + MIN);
});

test("sendAt: three notices in a row make one message, not three", () => {
  // Ровно случай из лога 19:05:11 / 19:05:13 / 19:05:15: коды разные, окно общее.
  const first = T0;
  const due = sendAt(first + 4_000, { lastSentAt: 0, firstQueuedAt: first });
  assert.equal(due, first + MIN, "the deadline counts from the batch's first notice, not its last");
});

// ------------------------------------------------------------------ база: неудачи подряд
test("streak: a single failure stays silent, the third in a row speaks once", () => {
  let s;
  ({ state: s } = streak(undefined, false));
  assert.equal(streak(s, false).say, null, "the second in a row is not trouble yet");
  ({ state: s } = streak(s, false));
  const third = streak(s, false);
  assert.equal(third.say, "down");
  assert.equal(third.state.fails, DB_STREAK);
  assert.equal(streak(third.state, false).say, null, "the fourth stays silent, we already said it");
});

test("streak: recovery is reported once and only if we complained", () => {
  let s = { fails: 3, told: true };
  const back = streak(s, true);
  assert.equal(back.say, "up");
  assert.deepEqual(back.state, { fails: 0, told: false });
  assert.equal(streak(back.state, true).say, null, "a second successful poll is not an event");
  assert.equal(streak({ fails: 2, told: false }, true).say, null, "we did not complain, so we do not report back");
});

// ------------------------------------------------------------------ прогрев
test("sleepGap: a tick right on the minute — the computer did not sleep", () => {
  assert.equal(sleepGap(T0, T0 + MIN), 0);
  assert.equal(sleepGap(T0, T0 + JUMP_MS), 0, "exactly at the threshold is not sleep yet");
  assert.equal(sleepGap(null, T0 + 99 * MIN), 0, "there has been no first tick yet");
});

test("sleepGap: a clock jump — that is how many minutes were slept", () => {
  assert.equal(sleepGap(T0, T0 + 89 * MIN), 89);   // 17:35 → 19:04, как в логе
});

test("isWarm: the warmup ends by itself", () => {
  const until = T0 + WARMUP_MS;
  assert.equal(isWarm(T0 + 1_000, until), true);
  assert.equal(isWarm(T0 + WARMUP_MS, until), false);
  assert.equal(isWarm(T0, 0), false, "there was no warmup at all");
});

// ------------------------------------------------------------------ Realtime
test("realtimeStep: a blink within five minutes — not a word", () => {
  const down = realtimeStep({ downSince: null, told: false }, false, T0);
  assert.equal(down.say, null);
  const up = realtimeStep(down.state, true, T0 + 2_000);
  assert.equal(up.say, null, "it came back in 2 seconds — that is not an event");
  assert.deepEqual(up.state, { downSince: null, told: false });
});

test("realtimeStep: a burst of errors does not move the start of the outage", () => {
  const a = realtimeStep({ downSince: null, told: false }, false, T0);
  const b = realtimeStep(a.state, false, T0 + 30_000);
  assert.equal(b.state.downSince, T0);
});

test("realtimeDown: the watchdog stays silent before the deadline and fires once", () => {
  const state = { downSince: T0, told: false };
  assert.equal(realtimeDown(state, T0 + 4 * MIN).say, null);
  const late = realtimeDown(state, T0 + REALTIME_DOWN_MS);
  assert.deepEqual(late.say, { kind: "down", since: T0 });
  assert.equal(late.state.told, true);
  assert.equal(realtimeDown(late.state, T0 + 20 * MIN).say, null, "we do not report the same thing twice");
});

test("realtimeDown + realtimeStep: recovery after a long outage is reported with the outage length", () => {
  const state = realtimeDown({ downSince: T0, told: false }, T0 + REALTIME_DOWN_MS).state;
  const up = realtimeStep(state, true, T0 + 12 * MIN);
  assert.deepEqual(up.say, { kind: "up", minutes: 12 });
  assert.deepEqual(up.state, { downSince: null, told: false });
});

// ------------------------------------------------------------------ демо-креаторы
const creators = () => [
  { code: "creator", text: "@demo.maks: profile not found" },
  { code: "creator", text: "@demo.dasha: profile not found" },
  { code: "db", text: "the run summary was not saved" },
];

test("squashKnown: the first time every line goes out, and memory remembers them", () => {
  const { items, memory, suppressed } = squashKnown(creators(), {}, T0);
  assert.equal(suppressed, 0);
  assert.equal(items.length, 3);
  assert.equal(Object.keys(memory).length, 2, "only creator lines are remembered");
});

test("squashKnown: the same creators on the same day collapse into one line", () => {
  const first = squashKnown(creators(), {}, T0);
  const again = squashKnown(creators(), first.memory, T0 + 2 * 60 * MIN);
  assert.equal(again.suppressed, 2);
  assert.deepEqual(again.items, [
    { code: "db", text: "the run summary was not saved" },
    { code: "creator", text: "2 more creators with the same old errors (see earlier messages)" },
  ]);
});

test("squashKnown: a different error for the same creator is not an old one and goes out", () => {
  const first = squashKnown(creators(), {}, T0);
  const other = squashKnown([{ code: "creator", text: "@demo.maks: stop screen" }], first.memory, T0 + MIN);
  assert.equal(other.suppressed, 0);
  assert.equal(other.items.length, 1);
});

test("squashKnown: after a day an old error goes out again and memory is cleaned", () => {
  const first = squashKnown(creators(), {}, T0);
  const later = squashKnown(creators(), first.memory, T0 + SAME_ERROR_MS + MIN);
  assert.equal(later.suppressed, 0);
  assert.equal(later.items.length, 3);
  assert.equal(Object.keys(later.memory).length, 2, "old records do not pile up");
});

test("squashKnown: the repeat counter within a run is not lost", () => {
  const first = squashKnown([{ code: "creator", text: "@a: profile not found" }], {}, T0);
  const again = squashKnown([{ code: "creator", text: "@a: profile not found", count: 3 }], first.memory, T0 + MIN);
  assert.match(again.items[0].text, /3 more creators/);
});


// --- Письмо только при потере данных (владелец, 2026-09-13), но пугливо (он же, 2026-09-16) ---

test("dataLost: every creator was collected, notices are about progress — no message", () => {
  const items = [{ code: "slow", text: "@a: took 3 min" }, { code: "direct", text: "fell back to the browser" }];
  assert.equal(dataLost({ failed: 0, items }), false);
});

test("dataLost: even one creator not collected calls for a message", () => {
  assert.equal(dataLost({ failed: 1, items: [{ code: "creator", text: "@a: profile not found" }] }), true);
});

test("dataLost: the run never started (run) — a message is needed even without creator errors", () => {
  assert.equal(dataLost({ failed: 0, items: [{ code: "run", text: "the run never started" }] }), true);
});

test("dataLost: something is missing — a message, even though no creator failed", () => {
  // Ровно тот случай, из-за которого правило и меняли: мёртвая сессия Instagram давала
  // зелёный обход с нулём публикаций.
  for (const code of ["missing", "session", "comments", "replies", "list", "limit", "stop", "images", "db"]) {
    assert.equal(dataLost({ failed: 0, items: [{ code, text: "trouble" }] }), true, `code ${code} must produce a message`);
  }
});

test("dataLost: an unknown code disturbs the owner — only the listed ones stay silent", () => {
  assert.equal(dataLost({ failed: 0, items: [{ code: "brand-new-code-that-does-not-exist-yet", text: "?" }] }), true);
  assert.equal(dataLost({ failed: 0, items: [{ code: "browser", text: "started on the second try" }] }), false);
});

test("squashKnown: a repeated shortfall is not sent for a day, but one line mentions it", () => {
  const item = { code: "missing", text: "@lis: 2 videos came back, while the DB has 7 for the same period" };
  const first = squashKnown([item], {}, T0);
  assert.equal(first.items.length, 1);
  assert.equal(first.suppressed, 0);
  const again = squashKnown([item], first.memory, T0 + MIN);
  assert.equal(again.suppressed, 1);
  assert.match(again.items[0].text, /more old notices/);
  // Сутки прошли — беда напоминает о себе снова.
  const later = squashKnown([item], again.memory, T0 + 25 * 60 * MIN);
  assert.equal(later.suppressed, 0);
  assert.equal(later.items[0].text, item.text);
});

// --- Сторож входа по сроку cookie (владелец, 2026-09-16) ---

const DAY = 24 * 60 * MIN;

test("sessionWatch: the first sighting and a renewal stay silent", () => {
  const first = sessionWatch(null, { expiresMs: T0 + 365 * DAY, now: T0 });
  assert.equal(first.say, null);
  assert.equal(first.state.expiresMs, T0 + 365 * DAY);
  // Обход через день продлил cookie — память о застое сбрасывается.
  const moved = sessionWatch(first.state, { expiresMs: T0 + 366 * DAY, now: T0 + DAY });
  assert.equal(moved.say, null);
  assert.equal(moved.state.movedAt, T0 + DAY);
});

test("sessionWatch: the cookie has not been renewed for a third day — we say so, exactly once", () => {
  const start = sessionWatch(null, { expiresMs: T0 + 365 * DAY, now: T0 });
  const quiet = sessionWatch(start.state, { expiresMs: T0 + 365 * DAY, now: T0 + 2 * DAY });
  assert.equal(quiet.say, null, "two days is not trouble yet");
  const said = sessionWatch(quiet.state, { expiresMs: T0 + 365 * DAY, now: T0 + 3 * DAY });
  assert.equal(said.say?.kind, "stale");
  assert.equal(said.say?.days, 3);
  const silent = sessionWatch(said.state, { expiresMs: T0 + 365 * DAY, now: T0 + 4 * DAY });
  assert.equal(silent.say, null, "one message per one and the same trouble");
});

test("sessionWatch: a near expiry outweighs staleness and is also said once", () => {
  const start = sessionWatch(null, { expiresMs: T0 + 10 * DAY, now: T0 });
  const said = sessionWatch(start.state, { expiresMs: T0 + 10 * DAY, now: T0 + 3 * DAY });
  assert.equal(said.say?.kind, "soon");
  assert.equal(said.say?.days, 7);
  assert.equal(sessionWatch(said.state, { expiresMs: T0 + 10 * DAY, now: T0 + 4 * DAY }).say, null);
});

test("sessionWatch: no cookie at all — the watchdog stays silent, not its case", () => {
  const start = sessionWatch(null, { expiresMs: T0 + 365 * DAY, now: T0 });
  const gone = sessionWatch(start.state, { expiresMs: null, now: T0 + 5 * DAY });
  assert.equal(gone.say, null);
  assert.equal(gone.state.expiresMs, T0 + 365 * DAY, "the memory of the previous expiry is not lost");
});

// --- пропавшие видео: одно письмо на видео, дальше только лог (владелец, 2026-09-16) ---

test("splitVanished: newly vanished videos go into the message and are remembered", () => {
  const got = splitVanished(["e", "d", "f"], {}, T0);
  assert.deepEqual(got.fresh, ["e", "d", "f"]);
  assert.deepEqual(got.known, []);
  assert.deepEqual(got.memory, { e: T0, d: T0, f: T0 });
});

test("splitVanished: 🔴 the same video missing again — no message, not even a month later", () => {
  const first = splitVanished(["e", "d"], {}, T0);
  const next = splitVanished(["e", "d"], first.memory, T0 + 30 * 24 * 60 * MIN);
  assert.deepEqual(next.fresh, [], "the memory is not daily: until the video returns we stay silent about it");
  assert.deepEqual(next.known, ["e", "d"]);
  assert.equal(next.memory.e, T0, "the date of the first message is not overwritten");
});

test("splitVanished: a new one joins the old vanished — we report only it", () => {
  const first = splitVanished(["e"], {}, T0);
  const next = splitVanished(["e", 17900], first.memory, T0 + MIN);
  assert.deepEqual(next.fresh, ["17900"], "the id is cast to a string, as in the DB");
  assert.deepEqual(next.known, ["e"]);
});

test("splitVanished: empty and garbage — we report nothing and do not spoil the memory", () => {
  const got = splitVanished([null, undefined], { x: T0 }, T0 + MIN);
  assert.deepEqual(got, { fresh: [], known: [], memory: { x: T0 } });
});

// --- письмо из одних прежних замечаний не уходит (владелец, 2026-09-16, письмо #135) ---

test("squashKnown.fresh: everything is old — zero new, even though the summary line would stay in the message", () => {
  const item = { code: "missing", text: "@lis: 2 videos came back, while the DB has 7 for the same period" };
  const first = squashKnown([item], {}, T0);
  assert.equal(first.fresh, 1);
  const again = squashKnown([item], first.memory, T0 + MIN);
  assert.equal(again.items.length, 1, "the summary \"1 more old notices\" is in the list…");
  assert.equal(again.fresh, 0, "…but it does not count as new — there must be no message");
});

test("squashKnown.fresh: a new one joins the old — a message is needed", () => {
  const old = { code: "creator", text: "@aurea: profile not found" };
  const first = squashKnown([old], {}, T0);
  const next = squashKnown([old, { code: "session", text: "the login has not been renewed for 3 d" }], first.memory, T0 + MIN);
  assert.equal(next.fresh, 1);
});

// --- видео вернулось в профиль — память о пропаже стирается (владелец, 2026-09-16) ---

test("forgetReturned: seen in the list — we forget it, the rest stay", () => {
  const got = forgetReturned({ e: T0, d: T0, f: T0 }, ["d", "zzz"]);
  assert.deepEqual(got.returned, ["d"]);
  assert.deepEqual(got.memory, { e: T0, f: T0 });
});

test("forgetReturned: nobody returned — the memory is unchanged, ids compare as strings", () => {
  assert.deepEqual(forgetReturned({ "17900": T0 }, [17901, null]), { memory: { "17900": T0 }, returned: [] });
  assert.deepEqual(forgetReturned({ "17900": T0 }, [17900]).returned, ["17900"]);
});

test("🔴 deleted → message, returned → forgotten, deleted again → message again", () => {
  const gone = splitVanished(["e"], {}, T0);
  assert.deepEqual(gone.fresh, ["e"], "the first disappearance gets a message");
  assert.deepEqual(splitVanished(["e"], gone.memory, T0 + MIN).fresh, [], "the same disappearance stays silent");
  const back = forgetReturned(gone.memory, ["e", "a"]);
  assert.deepEqual(back.returned, ["e"], "back in the profile");
  const again = splitVanished(["e"], back.memory, T0 + 3 * 24 * 60 * MIN);
  assert.deepEqual(again.fresh, ["e"], "vanished again — a message again");
});

test("shortOnce: \"the list is shorter than the profile\" is reported once, repeats stay silent", () => {
  // Владелец, 2026-09-17: «если один раз пришло, то второй не нужно».
  const first = shortOnce({}, "c1", { short: true, now: T0 });
  assert.equal(first.say, true);
  assert.deepEqual(first.memory, { c1: T0 });
  const second = shortOnce(first.memory, "c1", { short: true, now: T0 + 24 * 60 * MIN });
  assert.equal(second.say, false, "a day later the same gap is still silent");
  assert.deepEqual(second.memory, { c1: T0 }, "the first report date is not moved");
  assert.equal(shortOnce(first.memory, "c2", { short: true, now: T0 }).say, true, "another creator has its own memory");
});

test("shortOnce: the list caught up with the profile — the episode is over, a new gap is reported again", () => {
  const told = { c1: T0, c2: T0 };
  const healed = shortOnce(told, "c1", { healed: true, now: T0 + MIN });
  assert.equal(healed.say, false);
  assert.deepEqual(healed.memory, { c2: T0 });
  assert.equal(shortOnce(healed.memory, "c1", { short: true, now: T0 + 2 * MIN }).say, true);
});

test("shortOnce: nothing to judge (unfinished list, silent profile) — memory stays as it was", () => {
  const got = shortOnce({ c1: T0 }, "c1", { now: T0 + MIN });
  assert.equal(got.say, false);
  assert.deepEqual(got.memory, { c1: T0 });
  assert.deepEqual(shortOnce(undefined, 7, { short: true, now: T0 }).memory, { 7: T0 }, "ids are strings, missing memory is empty");
});
