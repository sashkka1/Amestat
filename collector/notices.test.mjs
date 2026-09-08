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
  buildMessage, sendAt, streak, sleepGap, isWarm, realtimeStep, realtimeDown, squashKnown,
  DB_STREAK, REALTIME_DOWN_MS, WARMUP_MS, JUMP_MS, SAME_ERROR_MS,
} from "./notices.mjs";

const MIN = 60_000;
const T0 = Date.parse("2026-09-08T19:05:00");

// ------------------------------------------------------------------ сообщение
test("buildMessage: шапка, строки с кодом и счётчик повторов", () => {
  const text = buildMessage("шапка", [
    { code: "creator", text: "@a: профиль не найден" },
    { code: "db", text: "не записалось", count: 3 },
  ]);
  assert.equal(text, "шапка\n[creator] @a: профиль не найден\n[db] не записалось (×3)");
});

test("buildMessage: лишнее не теряется молча, а считается", () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ code: "creator", text: `строка ${i} `.repeat(10) }));
  const text = buildMessage("шапка", items, 300);
  assert.ok(text.length <= 300, `длина ${text.length}`);
  assert.match(text.split("\n").at(-1), /^… и ещё \d+$/);
});

// ------------------------------------------------------------------ пачка резидентских писем
test("sendAt: первое письмо не раньше минуты после первого замечания", () => {
  assert.equal(sendAt(T0, { lastSentAt: 0, firstQueuedAt: T0 }), T0 + MIN);
});

test("sendAt: следующее письмо не раньше чем через 5 минут после прошлого", () => {
  // Замечание легло сразу после письма: минуты сбора мало, ждём конца пятиминутного окна.
  const due = sendAt(T0 + 10_000, { lastSentAt: T0, firstQueuedAt: T0 + 10_000 });
  assert.equal(due, T0 + 5 * MIN);
});

test("sendAt: замечание в конце окна ждёт только минуту сбора", () => {
  const late = T0 + 5 * MIN;   // окно уже почти истекло
  assert.equal(sendAt(late, { lastSentAt: T0, firstQueuedAt: late }), late + MIN);
});

test("sendAt: три замечания подряд — одно письмо, а не три", () => {
  // Ровно случай из лога 19:05:11 / 19:05:13 / 19:05:15: коды разные, окно общее.
  const first = T0;
  const due = sendAt(first + 4_000, { lastSentAt: 0, firstQueuedAt: first });
  assert.equal(due, first + MIN, "срок считается от первого замечания пачки, а не от последнего");
});

// ------------------------------------------------------------------ база: неудачи подряд
test("streak: одиночная неудача молчит, третья подряд говорит один раз", () => {
  let s;
  ({ state: s } = streak(undefined, false));
  assert.equal(streak(s, false).say, null, "вторая подряд — ещё не беда");
  ({ state: s } = streak(s, false));
  const third = streak(s, false);
  assert.equal(third.say, "down");
  assert.equal(third.state.fails, DB_STREAK);
  assert.equal(streak(third.state, false).say, null, "четвёртая — молчим, уже сказали");
});

test("streak: о возвращении говорим один раз и только если жаловались", () => {
  let s = { fails: 3, told: true };
  const back = streak(s, true);
  assert.equal(back.say, "up");
  assert.deepEqual(back.state, { fails: 0, told: false });
  assert.equal(streak(back.state, true).say, null, "второй удачный опрос — не событие");
  assert.equal(streak({ fails: 2, told: false }, true).say, null, "не жаловались — не отчитываемся");
});

// ------------------------------------------------------------------ прогрев
test("sleepGap: тик минута в минуту — компьютер не спал", () => {
  assert.equal(sleepGap(T0, T0 + MIN), 0);
  assert.equal(sleepGap(T0, T0 + JUMP_MS), 0, "ровно порог — ещё не сон");
  assert.equal(sleepGap(null, T0 + 99 * MIN), 0, "первого тика ещё не было");
});

test("sleepGap: прыжок часов — столько минут проспали", () => {
  assert.equal(sleepGap(T0, T0 + 89 * MIN), 89);   // 17:35 → 19:04, как в логе
});

test("isWarm: прогрев кончается сам", () => {
  const until = T0 + WARMUP_MS;
  assert.equal(isWarm(T0 + 1_000, until), true);
  assert.equal(isWarm(T0 + WARMUP_MS, until), false);
  assert.equal(isWarm(T0, 0), false, "прогрева не было вовсе");
});

// ------------------------------------------------------------------ Realtime
test("realtimeStep: мигание внутри пяти минут — ни слова", () => {
  const down = realtimeStep({ downSince: null, told: false }, false, T0);
  assert.equal(down.say, null);
  const up = realtimeStep(down.state, true, T0 + 2_000);
  assert.equal(up.say, null, "вернулся через 2 секунды — это не событие");
  assert.deepEqual(up.state, { downSince: null, told: false });
});

test("realtimeStep: пачка ошибок подряд не сдвигает начало перерыва", () => {
  const a = realtimeStep({ downSince: null, told: false }, false, T0);
  const b = realtimeStep(a.state, false, T0 + 30_000);
  assert.equal(b.state.downSince, T0);
});

test("realtimeDown: сторож молчит раньше срока и срабатывает один раз", () => {
  const state = { downSince: T0, told: false };
  assert.equal(realtimeDown(state, T0 + 4 * MIN).say, null);
  const late = realtimeDown(state, T0 + REALTIME_DOWN_MS);
  assert.deepEqual(late.say, { kind: "down", since: T0 });
  assert.equal(late.state.told, true);
  assert.equal(realtimeDown(late.state, T0 + 20 * MIN).say, null, "второй раз о том же не пишем");
});

test("realtimeDown + realtimeStep: о возвращении после долгого перерыва говорим с длиной перерыва", () => {
  const state = realtimeDown({ downSince: T0, told: false }, T0 + REALTIME_DOWN_MS).state;
  const up = realtimeStep(state, true, T0 + 12 * MIN);
  assert.deepEqual(up.say, { kind: "up", minutes: 12 });
  assert.deepEqual(up.state, { downSince: null, told: false });
});

// ------------------------------------------------------------------ демо-креаторы
const creators = () => [
  { code: "creator", text: "@demo.maks: профиль не найден" },
  { code: "creator", text: "@demo.dasha: профиль не найден" },
  { code: "db", text: "итог обхода не записался" },
];

test("squashKnown: в первый раз уходят все строки, память их запоминает", () => {
  const { items, memory, suppressed } = squashKnown(creators(), {}, T0);
  assert.equal(suppressed, 0);
  assert.equal(items.length, 3);
  assert.equal(Object.keys(memory).length, 2, "запоминаются только строки creator");
});

test("squashKnown: те же креаторы в тот же день — одна строка вместо всех", () => {
  const first = squashKnown(creators(), {}, T0);
  const again = squashKnown(creators(), first.memory, T0 + 2 * 60 * MIN);
  assert.equal(again.suppressed, 2);
  assert.deepEqual(again.items, [
    { code: "db", text: "итог обхода не записался" },
    { code: "creator", text: "ещё 2 креаторов с прежними ошибками (см. прошлые письма)" },
  ]);
});

test("squashKnown: другая ошибка того же креатора — не прежняя, уходит письмом", () => {
  const first = squashKnown(creators(), {}, T0);
  const other = squashKnown([{ code: "creator", text: "@demo.maks: стоп-экран" }], first.memory, T0 + MIN);
  assert.equal(other.suppressed, 0);
  assert.equal(other.items.length, 1);
});

test("squashKnown: через сутки прежняя ошибка снова письмо, а память чистится", () => {
  const first = squashKnown(creators(), {}, T0);
  const later = squashKnown(creators(), first.memory, T0 + SAME_ERROR_MS + MIN);
  assert.equal(later.suppressed, 0);
  assert.equal(later.items.length, 3);
  assert.equal(Object.keys(later.memory).length, 2, "старые записи не копятся");
});

test("squashKnown: счётчик повторов внутри обхода не теряется", () => {
  const first = squashKnown([{ code: "creator", text: "@a: профиль не найден" }], {}, T0);
  const again = squashKnown([{ code: "creator", text: "@a: профиль не найден", count: 3 }], first.memory, T0 + MIN);
  assert.match(again.items[0].text, /ещё 3 креаторов/);
});
