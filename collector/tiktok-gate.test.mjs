// Лимит запусков чистого профиля TikTok: `npm test` в collector.
// Браузера здесь нет вовсе — только расчёт окна и работа с файлом отметок.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchAllowed, readLaunches, takeLaunchSlot } from "./tiktok-gate.mjs";

const MIN = 60_000;
const WINDOW = 15 * MIN;
const NOW = Date.parse("2026-09-09T13:00:00Z");
// Метки «столько-то минут назад».
const ago = (...mins) => mins.map((m) => NOW - m * MIN);

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

test("свободное окно — метка ложится в файл, ждать не пришлось", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amestat-gate-"));
  const file = join(dir, "tiktok-launches.json");
  try {
    const res = await takeLaunchSlot({ limit: 2, windowMs: WINDOW, file, now: () => NOW, sleepFn: async () => {} });
    assert.equal(res.waited, 0);
    assert.deepEqual(readLaunches(file), [NOW], "запуск отмечен");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("окно занято — ждём, говорим об этом один раз и уходим, когда место освободилось", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amestat-gate-"));
  const file = join(dir, "tiktok-launches.json");
  writeFileSync(file, JSON.stringify(ago(14, 13)), "utf8");
  let clock = NOW;
  const waits = [];
  try {
    const res = await takeLaunchSlot({
      limit: 2,
      windowMs: WINDOW,
      file,
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
    assert.equal(stamps.at(-1), clock);
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
