// Radmin перед обходом: `npm test` в collector.
// Ни PowerShell, ни браузера здесь нет — только разбор состояния и правило «мешает ли Radmin».

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRadminState, radminActive, traceLabel } from "./radmin.mjs";

test("state parsing: service and adapter as strings", () => {
  assert.deepEqual(parseRadminState('{"service":"Running","adapter":"Up"}'), { service: "Running", adapter: "Up" });
  assert.deepEqual(parseRadminState('{"service":"Stopped","adapter":"Disabled"}\r\n'), { service: "Stopped", adapter: "Disabled" });
});

test("state parsing: Radmin not installed or garbage — everything empty", () => {
  assert.deepEqual(parseRadminState('{"service":null,"adapter":null}'), { service: null, adapter: null });
  assert.deepEqual(parseRadminState(""), { service: null, adapter: null });
  assert.deepEqual(parseRadminState("Get-Service : error"), { service: null, adapter: null });
});

test("in the way if the service runs or the adapter is not disabled", () => {
  assert.equal(radminActive({ service: "Running", adapter: "Up" }), true);
  assert.equal(radminActive({ service: "Running", adapter: "Disabled" }), true, "a live service turns the adapter back on");
  assert.equal(radminActive({ service: "Stopped", adapter: "Up" }), true, "the adapter grabs the bypass rule even without the service");
  assert.equal(radminActive({ service: "Stopped", adapter: "Disconnected" }), true);
});

test("not in the way: everything off or no Radmin at all", () => {
  assert.equal(radminActive({ service: "Stopped", adapter: "Disabled" }), false);
  assert.equal(radminActive({ service: null, adapter: null }), false);
  assert.equal(radminActive({ service: "Stopped", adapter: "Not Present" }), false);
  assert.equal(radminActive(), false);
});

test("address label from the Cloudflare trace", () => {
  assert.equal(traceLabel("fl=1\nip=185.203.152.146\nloc=BY\ncolo=WAW"), "185.203.152.146, BY");
  assert.equal(traceLabel("ip=1.2.3.4"), "1.2.3.4");
  assert.equal(traceLabel("<html>"), null);
});
