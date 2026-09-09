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

test("разбор строки прокси: схемы, порт, логин и пароль отдельно от адреса", () => {
  const list = parseProxies("http://user:pass@1.2.3.4:8080,socks5://u2:p2@5.6.7.8:1080,https://9.9.9.9:3128");
  assert.equal(list.length, 3);
  assert.deepEqual(list[0], { server: "http://1.2.3.4:8080", username: "user", password: "pass", host: "1.2.3.4:8080" });
  assert.equal(list[1].server, "socks5://5.6.7.8:1080", "логин и пароль в server не попадают");
  assert.equal(list[1].password, "p2");
  assert.deepEqual(list[2], { server: "https://9.9.9.9:3128", username: "", password: "", host: "9.9.9.9:3128" });
});

test("пусто, мусор и неизвестные схемы пропускаются молча", () => {
  assert.deepEqual(parseProxies(""), []);
  assert.deepEqual(parseProxies(undefined), []);
  assert.deepEqual(parseProxies("не адрес, ftp://1.2.3.4:21, ,"), []);
  const one = parseProxies(" , http://1.2.3.4:8080 , мусор");
  assert.equal(one.length, 1, "годная строка среди мусора берётся");
});

test("пароль со знаками пишется процентами и разбирается обратно", () => {
  const [p] = parseProxies("http://user:pa%40ss%3A1@1.2.3.4:8080");
  assert.equal(p.password, "pa@ss:1");
  assert.equal(p.server, "http://1.2.3.4:8080");
});

test("список адресов: домашний нулевой, номера прокси не зависят от него", () => {
  const proxies = parseProxies("http://u:p@1.1.1.1:8080,socks5://u:p@2.2.2.2:1080");
  const withHome = addressList(proxies, { home: true });
  assert.deepEqual(withHome.map((a) => a.id), [0, 1, 2]);
  assert.equal(withHome[0].label, "домашний");
  assert.equal(withHome[1].label, "прокси #1 1.1.1.1:8080");
  const noHome = addressList(proxies, { home: false });
  assert.deepEqual(noHome.map((a) => a.id), [1, 2], "выключенный домашний нумерацию прокси не сдвигает");
  assert.equal(labelOf(noHome, 2), "прокси #2 2.2.2.2:1080");
});

test("нет ни прокси, ни домашнего — всё равно ходим с домашнего", () => {
  const list = addressList([], { home: false });
  assert.deepEqual(list.map((a) => a.id), [0]);
});

test("чередование по кругу: курсор переносится между запусками", () => {
  const list = addressList(parseProxies("http://1.1.1.1:8080,http://2.2.2.2:8080"), { home: true });
  let state = emptyState();
  const taken = [];
  for (let i = 0; i < 4; i++) {
    const res = nextAddress(state, NOW, list);
    taken.push(res.address.id);
    state = res.state;
  }
  assert.deepEqual(taken, [0, 1, 2, 0], "адреса идут по кругу, а не один и тот же");
});

test("адрес в паузе пропускается, а по её истечении возвращается в круг", () => {
  const list = addressList(parseProxies("http://1.1.1.1:8080"), { home: true });
  const state = markBad(emptyState(), 0, NOW, COOLDOWN);
  assert.equal(pausedUntil(state, 0, NOW), NOW + COOLDOWN);
  const now = nextAddress(state, NOW, list);
  assert.equal(now.address.id, 1, "домашний в паузе — берём прокси");
  assert.equal(now.waitMs, 0);
  const later = nextAddress(state, NOW + COOLDOWN + 1, list);
  assert.equal(later.address.id, 0, "пауза кончилась — домашний снова первый по кругу");
});

test("удачный запуск снимает паузу и обнуляет счётчик неудач", () => {
  let state = markBad(emptyState(), 1, NOW, COOLDOWN);
  assert.equal(state.fails["1"], 1);
  state = markGood(state, 1, NOW);
  assert.equal(pausedUntil(state, 1, NOW), 0);
  assert.equal(state.fails["1"], 0);
  assert.equal(state.runs["1"], 1);
});

test("все в паузе — берём того, у кого она кончится раньше, и ждём", () => {
  const list = addressList(parseProxies("http://1.1.1.1:8080"), { home: true });
  let state = markBad(emptyState(), 0, NOW, 10 * MIN);
  state = markBad(state, 1, NOW, 25 * MIN);
  const res = nextAddress(state, NOW, list);
  assert.equal(res.address.id, 0, "домашний освободится через 10 минут — он и ближе");
  assert.equal(res.waitMs, 10 * MIN, "ждём столько же, сколько ждали бы окно лимита запусков");
});

test("лимит запусков считается на каждый адрес отдельно", () => {
  const list = addressList(parseProxies("http://1.1.1.1:8080"), { home: true });
  // Домашний исчерпан на 5 минут, прокси свободен.
  const free = (address) => (address.id === 0 ? { ok: false, waitMs: 5 * MIN } : { ok: true, waitMs: 0 });
  const res = nextAddress(emptyState(), NOW, list, { free });
  assert.equal(res.address.id, 1);
  assert.equal(res.waitMs, 0);
});

test("исключённый адрес не берётся; исключили всех — адреса нет вовсе", () => {
  const list = addressList(parseProxies("http://1.1.1.1:8080"), { home: true });
  assert.equal(nextAddress(emptyState(), NOW, list, { exclude: [0] }).address.id, 1);
  assert.equal(nextAddress(emptyState(), NOW, list, { exclude: [0, 1] }).address, null);
});

test("ошибка соединения отличается от беды площадки", () => {
  assert.ok(looksLikeProxyTrouble("page.goto: net::ERR_PROXY_CONNECTION_FAILED at https://tiktok.com"));
  assert.ok(looksLikeProxyTrouble("net::ERR_TUNNEL_CONNECTION_FAILED"));
  assert.equal(looksLikeProxyTrouble("профиль не найден: @kto_to"), false);
  assert.equal(looksLikeProxyTrouble("стоп-экран TikTok на профиле"), false);
});

test("состояние переживает запись и чтение, испорченный файл — как пустой", () => {
  const dir = mkdtempSync(join(tmpdir(), "amestat-proxy-"));
  const file = join(dir, "proxies-state.json");
  try {
    assert.deepEqual(readProxyState(file), emptyState(), "файла нет — пул чистый");
    assert.equal(writeProxyState(markBad(emptyState(), 2, NOW, COOLDOWN), file), null);
    const back = readProxyState(file);
    assert.equal(back.bad["2"], NOW + COOLDOWN);
    assert.equal(back.fails["2"], 1);
    writeFileSync(file, "{не json", "utf8");
    assert.deepEqual(readProxyState(file), emptyState());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
