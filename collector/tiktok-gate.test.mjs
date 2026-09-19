// Лимит запусков чистого профиля TikTok: `npm test` в collector.
// Браузера здесь нет вовсе — только расчёт окна и работа с файлом отметок.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchAllowed, readLaunches, takeLaunchSlot } from "./tiktok-gate.mjs";
import { addressList, parseProxies, emptyState, markBad, writeProxyState, readProxyState } from "./proxies.mjs";

const MIN = 60_000;
const WINDOW = 15 * MIN;
const NOW = Date.parse("2026-09-09T13:00:00Z");
// Метки «столько-то минут назад» — старого вида, голыми числами: их писали до пула адресов.
const ago = (...mins) => mins.map((m) => NOW - m * MIN);
// Те же метки, но с адресом: `at(2, 1)` — запуск две минуты назад с прокси #1.
const at = (min, address) => ({ at: NOW - min * MIN, address });
// Пул из домашнего адреса и одного прокси.
const POOL = addressList(parseProxies("http://1.1.1.1:8080"), { home: true });

test("fewer launches than the limit — go right away", () => {
  assert.deepEqual(launchAllowed([], NOW, 6, WINDOW), { ok: true, waitMs: 0 });
  assert.deepEqual(launchAllowed(ago(1, 2, 3, 4, 5), NOW, 6, WINDOW), { ok: true, waitMs: 0 });
});

test("six launches in 15 minutes — wait until the oldest expires", () => {
  const { ok, waitMs } = launchAllowed(ago(14, 12, 10, 8, 6, 4), NOW, 6, WINDOW);
  assert.equal(ok, false);
  assert.equal(waitMs, 1 * MIN, "the oldest stamp is 14 minutes old — a slot frees up in a minute");
});

test("old stamps do not count at all", () => {
  const { ok } = launchAllowed(ago(40, 30, 20, 16, 15.5, 3), NOW, 6, WINDOW);
  assert.equal(ok, true, "only one fresh stamp — the window is almost empty");
});

test("garbage in the file and stamps from the future do not break the calculation", () => {
  assert.deepEqual(launchAllowed([null, "yesterday", NaN], NOW, 6, WINDOW), { ok: true, waitMs: 0 });
  assert.deepEqual(launchAllowed([NOW + 5 * MIN], NOW, 1, WINDOW), { ok: true, waitMs: 0 });
});

test("limit of one: wait exactly one window since the previous launch", () => {
  const { ok, waitMs } = launchAllowed(ago(2), NOW, 1, WINDOW);
  assert.equal(ok, false);
  assert.equal(waitMs, 13 * MIN);
});

test("stamps of other addresses do not count: each has its own limit", () => {
  const stamps = [at(1, 1), at(2, 1), at(3, 1), at(4, 1), at(5, 1), at(6, 1)];
  assert.equal(launchAllowed(stamps, NOW, 6, WINDOW, 1).ok, false, "proxy #1 has its window taken");
  assert.equal(launchAllowed(stamps, NOW, 6, WINDOW, 0).ok, true, "this does not concern home");
});

test("old records without an address count as home", () => {
  const stamps = ago(14, 12, 10, 8, 6, 4);
  assert.equal(launchAllowed(stamps, NOW, 6, WINDOW, 0).ok, false, "six previous stamps belong to the home address");
  assert.equal(launchAllowed(stamps, NOW, 6, WINDOW, 1).ok, true, "proxy #1 has nothing to do with them");
  assert.deepEqual(readLaunchesOf([NOW - MIN]), [{ at: NOW - MIN, address: 0 }]);
});

// Разбор старых записей проверяется через файл: своей экспортированной функции у него нет.
function readLaunchesOf(raw) {
  const dir = mkdtempSync(join(tmpdir(), "amestat-gate-"));
  const file = join(dir, "tiktok-launches.json");
  try {
    writeFileSync(file, JSON.stringify(raw), "utf8");
    return readLaunches(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("free window — the stamp lands in the file with its address, no waiting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amestat-gate-"));
  const file = join(dir, "tiktok-launches.json");
  const stateFile = join(dir, "proxies-state.json");
  try {
    const res = await takeLaunchSlot({ limit: 2, windowMs: WINDOW, file, stateFile, now: () => NOW, sleepFn: async () => {} });
    assert.equal(res.waited, 0);
    assert.equal(res.address.id, 0, "no pool — we go from home");
    assert.deepEqual(readLaunches(file), [{ at: NOW, address: 0 }], "the launch is stamped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("window taken — wait, say so once and leave when a slot frees up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amestat-gate-"));
  const file = join(dir, "tiktok-launches.json");
  const stateFile = join(dir, "proxies-state.json");
  writeFileSync(file, JSON.stringify(ago(14, 13)), "utf8");
  let clock = NOW;
  const waits = [];
  try {
    const res = await takeLaunchSlot({
      limit: 2,
      windowMs: WINDOW,
      file,
      stateFile,
      now: () => clock,
      // Поддельный сон: двигаем часы вперёд вместо ожидания.
      sleepFn: async (ms) => { clock += ms; },
      onWait: (until) => waits.push(until.getTime()),
    });
    assert.equal(waits.length, 1, "we announce the wait once, not on every round");
    assert.equal(waits[0], NOW + 1 * MIN, "the oldest stamp is 14 minutes old");
    assert.ok(res.waited >= MIN, `waited ${res.waited} ms`);
    const stamps = readLaunches(file);
    assert.equal(stamps.length, 2, "the stamp older than the window is cleaned out, a new one written");
    assert.equal(stamps.at(-1).at, clock);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two addresses: a busy home does not hold up the run — we go via the proxy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amestat-gate-"));
  const file = join(dir, "tiktok-launches.json");
  const stateFile = join(dir, "proxies-state.json");
  writeFileSync(file, JSON.stringify(ago(14, 13)), "utf8");
  const waits = [];
  try {
    const res = await takeLaunchSlot({
      limit: 2, windowMs: WINDOW, addresses: POOL, file, stateFile,
      now: () => NOW, sleepFn: async () => {}, onWait: (until) => waits.push(until),
    });
    assert.equal(res.waited, 0, "no waiting at all");
    assert.equal(waits.length, 0);
    assert.equal(res.address.id, 1);
    assert.equal(res.address.label, "proxy #1 1.1.1.1:8080");
    assert.deepEqual(readLaunches(file).at(-1), { at: NOW, address: 1 });
    assert.equal(readProxyState(stateFile).cursor, 0, "the rotation advanced: home is next again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a paused address is not taken, and when all are busy we wait for the nearest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amestat-gate-"));
  const file = join(dir, "tiktok-launches.json");
  const stateFile = join(dir, "proxies-state.json");
  // Домашний исчерпал окно, прокси #1 в паузе на 5 минут — ждать придётся его.
  writeFileSync(file, JSON.stringify([at(14, 0), at(13, 0)]), "utf8");
  writeProxyState(markBad(emptyState(), 1, NOW, 5 * MIN), stateFile);
  let clock = NOW;
  const waits = [];
  try {
    const res = await takeLaunchSlot({
      limit: 2, windowMs: WINDOW, addresses: POOL, file, stateFile,
      now: () => clock, sleepFn: async (ms) => { clock += ms; },
      onWait: (until, ms, info) => waits.push({ until: until.getTime(), ms, info }),
    });
    assert.equal(waits.length, 1);
    assert.equal(waits[0].until, NOW + MIN, "home frees up in a minute — sooner than the proxy pause");
    assert.equal(waits[0].info.addresses, 2, "the log line must know there is more than one address");
    assert.equal(res.address.id, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("all addresses excluded — there will be no second attempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amestat-gate-"));
  const file = join(dir, "tiktok-launches.json");
  const stateFile = join(dir, "proxies-state.json");
  try {
    const res = await takeLaunchSlot({
      limit: 6, windowMs: WINDOW, addresses: POOL, exclude: [0, 1], file, stateFile,
      now: () => NOW, sleepFn: async () => {},
    });
    assert.equal(res.address, null);
    assert.equal(res.waited, 0);
    assert.deepEqual(readLaunches(file), [], "an idle pass writes no stamp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupted stamp file reads as if there were no launches", () => {
  const dir = mkdtempSync(join(tmpdir(), "amestat-gate-"));
  const file = join(dir, "tiktok-launches.json");
  writeFileSync(file, "{not json", "utf8");
  try {
    assert.deepEqual(readLaunches(file), []);
    assert.equal(readFileSync(file, "utf8"), "{not json", "reading does not touch the file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
