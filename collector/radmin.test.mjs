// Radmin перед обходом: `npm test` в collector.
// Ни PowerShell, ни браузера здесь нет — только разбор состояния и правило «мешает ли Radmin».

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRadminState, radminActive, traceLabel } from "./radmin.mjs";

test("разбор состояния: служба и адаптер строками", () => {
  assert.deepEqual(parseRadminState('{"service":"Running","adapter":"Up"}'), { service: "Running", adapter: "Up" });
  assert.deepEqual(parseRadminState('{"service":"Stopped","adapter":"Disabled"}\r\n'), { service: "Stopped", adapter: "Disabled" });
});

test("разбор состояния: Radmin не установлен или мусор — всё пусто", () => {
  assert.deepEqual(parseRadminState('{"service":null,"adapter":null}'), { service: null, adapter: null });
  assert.deepEqual(parseRadminState(""), { service: null, adapter: null });
  assert.deepEqual(parseRadminState("Get-Service : ошибка"), { service: null, adapter: null });
});

test("мешает, если работает служба или не выключен адаптер", () => {
  assert.equal(radminActive({ service: "Running", adapter: "Up" }), true);
  assert.equal(radminActive({ service: "Running", adapter: "Disabled" }), true, "живая служба включит адаптер обратно");
  assert.equal(radminActive({ service: "Stopped", adapter: "Up" }), true, "адаптер перехватывает исключение и без службы");
  assert.equal(radminActive({ service: "Stopped", adapter: "Disconnected" }), true);
});

test("не мешает: всё выключено или Radmin нет вовсе", () => {
  assert.equal(radminActive({ service: "Stopped", adapter: "Disabled" }), false);
  assert.equal(radminActive({ service: null, adapter: null }), false);
  assert.equal(radminActive({ service: "Stopped", adapter: "Not Present" }), false);
  assert.equal(radminActive(), false);
});

test("метка адреса из Cloudflare trace", () => {
  assert.equal(traceLabel("fl=1\nip=185.203.152.146\nloc=BY\ncolo=WAW"), "185.203.152.146, BY");
  assert.equal(traceLabel("ip=1.2.3.4"), "1.2.3.4");
  assert.equal(traceLabel("<html>"), null);
});
