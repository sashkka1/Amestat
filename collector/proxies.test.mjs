// Пул адресов: `npm test` в collector. Ни браузера, ни сети — только разбор строк, круг и паузы.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseProxies, addressList, labelOf, nextAddress, markBad, markGood, pausedUntil,
  looksLikeProxyTrouble, readProxyState, writeProxyState, emptyState,
} from "./proxies.mjs";

const MIN = 60_000;
const NOW = Date.parse("2026-09-09T13:00:00Z");
const COOLDOWN = 30 * MIN;

test("proxy string parsing: schemes, port, login and password kept apart from the address", () => {
  const list = parseProxies("http://user:pass@1.2.3.4:8080,socks5://u2:p2@5.6.7.8:1080,https://9.9.9.9:3128");
  assert.equal(list.length, 3);
  assert.deepEqual(list[0], { server: "http://1.2.3.4:8080", username: "user", password: "pass", host: "1.2.3.4:8080" });
  assert.equal(list[1].server, "socks5://5.6.7.8:1080", "login and password do not leak into server");
  assert.equal(list[1].password, "p2");
  assert.deepEqual(list[2], { server: "https://9.9.9.9:3128", username: "", password: "", host: "9.9.9.9:3128" });
});

test("empty input, garbage and unknown schemes are skipped silently", () => {
  assert.deepEqual(parseProxies(""), []);
  assert.deepEqual(parseProxies(undefined), []);
  assert.deepEqual(parseProxies("not a url, ftp://1.2.3.4:21, ,"), []);
  const one = parseProxies(" , http://1.2.3.4:8080 , garbage");
  assert.equal(one.length, 1, "a valid entry among garbage is taken");
});

test("a password with special characters is percent-encoded and decoded back", () => {
  const [p] = parseProxies("http://user:pa%40ss%3A1@1.2.3.4:8080");
  assert.equal(p.password, "pa@ss:1");
  assert.equal(p.server, "http://1.2.3.4:8080");
});

test("address list: home is zero, proxy numbers do not depend on it", () => {
  const proxies = parseProxies("http://u:p@1.1.1.1:8080,socks5://u:p@2.2.2.2:1080");
  const withHome = addressList(proxies, { home: true });
  assert.deepEqual(withHome.map((a) => a.id), [0, 1, 2]);
  assert.equal(withHome[0].label, "home");
  assert.equal(withHome[1].label, "proxy #1 1.1.1.1:8080");
  const noHome = addressList(proxies, { home: false });
  assert.deepEqual(noHome.map((a) => a.id), [1, 2], "a disabled home address does not shift proxy numbering");
  assert.equal(labelOf(noHome, 2), "proxy #2 2.2.2.2:1080");
});

test("no proxies and no home — we still go from home", () => {
  const list = addressList([], { home: false });
  assert.deepEqual(list.map((a) => a.id), [0]);
});

test("round-robin: the cursor carries over between launches", () => {
  const list = addressList(parseProxies("http://1.1.1.1:8080,http://2.2.2.2:8080"), { home: true });
  let state = emptyState();
  const taken = [];
  for (let i = 0; i < 4; i++) {
    const res = nextAddress(state, NOW, list);
    taken.push(res.address.id);
    state = res.state;
  }
  assert.deepEqual(taken, [0, 1, 2, 0], "addresses rotate instead of repeating the same one");
});

test("a paused address is skipped and returns to the rotation once the pause ends", () => {
  const list = addressList(parseProxies("http://1.1.1.1:8080"), { home: true });
  const state = markBad(emptyState(), 0, NOW, COOLDOWN);
  assert.equal(pausedUntil(state, 0, NOW), NOW + COOLDOWN);
  const now = nextAddress(state, NOW, list);
  assert.equal(now.address.id, 1, "home is paused — take the proxy");
  assert.equal(now.waitMs, 0);
  const later = nextAddress(state, NOW + COOLDOWN + 1, list);
  assert.equal(later.address.id, 0, "the pause ended — home is first in the rotation again");
});

test("a successful launch clears the pause and resets the failure counter", () => {
  let state = markBad(emptyState(), 1, NOW, COOLDOWN);
  assert.equal(state.fails["1"], 1);
  state = markGood(state, 1, NOW);
  assert.equal(pausedUntil(state, 1, NOW), 0);
  assert.equal(state.fails["1"], 0);
  assert.equal(state.runs["1"], 1);
});

test("all paused — take the one that frees up first and wait", () => {
  const list = addressList(parseProxies("http://1.1.1.1:8080"), { home: true });
  let state = markBad(emptyState(), 0, NOW, 10 * MIN);
  state = markBad(state, 1, NOW, 25 * MIN);
  const res = nextAddress(state, NOW, list);
  assert.equal(res.address.id, 0, "home frees up in 10 minutes — it is the closer one");
  assert.equal(res.waitMs, 10 * MIN, "we wait as long as we would wait for the launch-limit window");
});

test("the launch limit is counted per address", () => {
  const list = addressList(parseProxies("http://1.1.1.1:8080"), { home: true });
  // Домашний исчерпан на 5 минут, прокси свободен.
  const free = (address) => (address.id === 0 ? { ok: false, waitMs: 5 * MIN } : { ok: true, waitMs: 0 });
  const res = nextAddress(emptyState(), NOW, list, { free });
  assert.equal(res.address.id, 1);
  assert.equal(res.waitMs, 0);
});

test("an excluded address is not taken; exclude them all and there is no address at all", () => {
  const list = addressList(parseProxies("http://1.1.1.1:8080"), { home: true });
  assert.equal(nextAddress(emptyState(), NOW, list, { exclude: [0] }).address.id, 1);
  assert.equal(nextAddress(emptyState(), NOW, list, { exclude: [0, 1] }).address, null);
});

test("a connection error differs from a platform problem", () => {
  assert.ok(looksLikeProxyTrouble("page.goto: net::ERR_PROXY_CONNECTION_FAILED at https://tiktok.com"));
  assert.ok(looksLikeProxyTrouble("net::ERR_TUNNEL_CONNECTION_FAILED"));
  assert.equal(looksLikeProxyTrouble("profile not found: @kto_to"), false);
  assert.equal(looksLikeProxyTrouble("TikTok stop screen on the profile"), false);
});

test("state survives a write and a read, a corrupted file reads as empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "amestat-proxy-"));
  const file = join(dir, "proxies-state.json");
  try {
    assert.deepEqual(readProxyState(file), emptyState(), "no file — the pool is clean");
    assert.equal(writeProxyState(markBad(emptyState(), 2, NOW, COOLDOWN), file), null);
    const back = readProxyState(file);
    assert.equal(back.bad["2"], NOW + COOLDOWN);
    assert.equal(back.fails["2"], 1);
    writeFileSync(file, "{not json", "utf8");
    assert.deepEqual(readProxyState(file), emptyState());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
