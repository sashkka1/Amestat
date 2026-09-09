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

test("запусков меньше лимита — идём сразу", () => {
  assert.deepEqual(launchAllowed([], NOW, 6, WINDOW), { ok: true, waitMs: 0 });
  assert.deepEqual(launchAllowed(ago(1, 2, 3, 4, 5), NOW, 6, WINDOW), { ok: true, waitMs: 0 });
});

test("шесть запусков за 15 минут — ждём, пока истечёт самый старый", () => {
  const { ok, waitMs } = launchAllowed(ago(14, 12, 10, 8, 6, 4), NOW, 6, WINDOW);
  assert.equal(ok, false);
  assert.equal(waitMs, 1 * MIN, "самой старой метке 14 минут — место освободится через минуту");
});

test("старые метки в счёт не идут вовсе", () => {
  const { ok } = launchAllowed(ago(40, 30, 20, 16, 15.5, 3), NOW, 6, WINDOW);
  assert.equal(ok, true, "свежая метка одна — окно почти пустое");
});

test("мусор в файле и метки из будущего расчёт не ломают", () => {
  assert.deepEqual(launchAllowed([null, "вчера", NaN], NOW, 6, WINDOW), { ok: true, waitMs: 0 });
  assert.deepEqual(launchAllowed([NOW + 5 * MIN], NOW, 1, WINDOW), { ok: true, waitMs: 0 });
});

test("лимит единица: ждём ровно окно с прошлого запуска", () => {
  const { ok, waitMs } = launchAllowed(ago(2), NOW, 1, WINDOW);
  assert.equal(ok, false);
  assert.equal(waitMs, 13 * MIN);
});

test("метки чужих адресов в счёт не идут: лимит у каждого свой", () => {
  const stamps = [at(1, 1), at(2, 1), at(3, 1), at(4, 1), at(5, 1), at(6, 1)];
  assert.equal(launchAllowed(stamps, NOW, 6, WINDOW, 1).ok, false, "у прокси #1 окно занято");
  assert.equal(launchAllowed(stamps, NOW, 6, WINDOW, 0).ok, true, "домашнего это не касается");
});

test("старые записи без адреса считаются домашними", () => {
  const stamps = ago(14, 12, 10, 8, 6, 4);
  assert.equal(launchAllowed(stamps, NOW, 6, WINDOW, 0).ok, false, "шесть прежних меток — это домашний адрес");
  assert.equal(launchAllowed(stamps, NOW, 6, WINDOW, 1).ok, true, "прокси #1 к ним отношения не имеет");
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

test("свободное окно — метка ложится в файл с адресом, ждать не пришлось", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amestat-gate-"));
  const file = join(dir, "tiktok-launches.json");
  const stateFile = join(dir, "proxies-state.json");
  try {
    const res = await takeLaunchSlot({ limit: 2, windowMs: WINDOW, file, stateFile, now: () => NOW, sleepFn: async () => {} });
    assert.equal(res.waited, 0);
    assert.equal(res.address.id, 0, "пула нет — идём с домашнего");
    assert.deepEqual(readLaunches(file), [{ at: NOW, address: 0 }], "запуск отмечен");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("окно занято — ждём, говорим об этом один раз и уходим, когда место освободилось", async () => {
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
    assert.equal(waits.length, 1, "об ожидании говорим один раз, а не на каждый круг");
    assert.equal(waits[0], NOW + 1 * MIN, "самой старой метке 14 минут");
    assert.ok(res.waited >= MIN, `прождали ${res.waited} мс`);
    const stamps = readLaunches(file);
    assert.equal(stamps.length, 2, "метка старше окна вычищена, новая записана");
    assert.equal(stamps.at(-1).at, clock);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("два адреса: занятый домашний не держит обход — идём с прокси", async () => {
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
    assert.equal(res.waited, 0, "ждать не пришлось вовсе");
    assert.equal(waits.length, 0);
    assert.equal(res.address.id, 1);
    assert.equal(res.address.label, "прокси #1 1.1.1.1:8080");
    assert.deepEqual(readLaunches(file).at(-1), { at: NOW, address: 1 });
    assert.equal(readProxyState(stateFile).cursor, 0, "круг провернулся: следующим снова домашний");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("адрес в паузе не берётся, а когда все заняты — ждём ближайшего", async () => {
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
    assert.equal(waits[0].until, NOW + MIN, "домашний освободится через минуту — он ближе паузы прокси");
    assert.equal(waits[0].info.addresses, 2, "строка лога должна знать, что адресов больше одного");
    assert.equal(res.address.id, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("исключили все адреса — второй попытки не будет", async () => {
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
    assert.deepEqual(readLaunches(file), [], "холостой заход метку не пишет");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("испорченный файл отметок — как будто запусков не было", () => {
  const dir = mkdtempSync(join(tmpdir(), "amestat-gate-"));
  const file = join(dir, "tiktok-launches.json");
  writeFileSync(file, "{не json", "utf8");
  try {
    assert.deepEqual(readLaunches(file), []);
    assert.equal(readFileSync(file, "utf8"), "{не json", "чтение файл не трогает");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
