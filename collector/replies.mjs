// Раскрытие веток ответов на комментарии — общее для обеих площадок.
//
// Приём один и тот же: под корневым комментарием висит кнопка («Просмотреть 7 ответов» у TikTok,
// «Смотреть все ответы (2)» у Instagram); клик по ней заставляет страницу спросить ответы своим
// запросом, а тела ловит тот же слушатель, что и корневые. Отличаются только подписи и
// `data-e2e`, поэтому они приходят параметрами, а порядок кликов живёт здесь.
//
// ⚠️ Какая ветка чья, решает НЕ разметка, а пришедший ответ: ни у TikTok, ни у Instagram в DOM
// комментария нет его id. Поэтому:
//   • ветки раскрываются строго ПО ОДНОЙ и с паузой — иначе не понять, к кому относится пришедшее;
//   • кнопка перед кликом помечается атрибутом `data-amestat="<номер>"`, и жмётся уже по метке:
//     по тексту в списке из сотни веток попадёшь не в ту, а второй раз в ту же — тем более;
//   • недожатые «ещё» помечаются как пройденные в конце каждой ветки, иначе следующая ветка
//     приняла бы их за свои.

const MARK_ATTR = "data-amestat";
const CLICK_TIMEOUT_MS = 5_000;
const GROWTH_STEP_MS = 300;      // как часто смотрим, приехало ли что-нибудь
const GROWTH_TAIL_MS = 400;      // хвост пачки слушатель дочитывает чуть позже клика
const BRANCH_WAIT_MS = 6_000;    // столько ждём прирост после раскрытия одной ветки
const MORE_ROUNDS = 10;          // потолок «ещё» внутри одной ветки
// Потолок времени на все ветки одного видео. Нужен вот зачем: у ветки, ответы которой площадка
// уже отдала даром, клик не вызывает никакого запроса — и такая ветка честно выжидает свои
// шесть секунд впустую. Сто таких веток на видео растянули бы шаг комментариев на четверть часа.
const BRANCHES_DEADLINE_MS = 90_000;

/**
 * Помечает следующую нетронутую кнопку и отдаёт `{ mark, how, text }` (или null, если её нет).
 * `selector` — надёжный признак разметки (у Instagram его нет вовсе, там `null`),
 * `textSource` — поиск по подписи: `data-e2e` площадки меняют чаще, чем слова на кнопке.
 */
function markButton(page, selector, textSource, mark) {
  return page.evaluate(([sel, src, id, attr]) => {
    const re = new RegExp(src, "i");
    const seen = (el) => el.hasAttribute(attr) || el.closest(`[${attr}]`) !== null;
    const take = (el, how) => {
      el.setAttribute(attr, String(id));
      el.scrollIntoView({ block: "center" });
      return { mark: id, how, text: String(el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60) };
    };
    for (const el of sel ? document.querySelectorAll(sel) : []) {
      if (!seen(el) && el.getClientRects().length > 0) return take(el, "разметке");
    }
    // Подписи ищем только в мелких узлах: у большого текст — это весь список комментариев.
    for (const el of document.querySelectorAll("span, p, button, div[role='button']")) {
      if (seen(el)) continue;
      const text = String(el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 40 || !re.test(text)) continue;
      if (el.getClientRects().length === 0) continue;
      return take(el, "тексту");
    }
    return null;
  }, [selector, textSource, mark, MARK_ATTR]);
}

/** Помечает все оставшиеся такие кнопки пройденными. Отдаёт, сколько пометилось. */
function markRest(page, selector, textSource, mark) {
  return page.evaluate(([sel, src, id, attr]) => {
    const re = new RegExp(src, "i");
    const seen = (el) => el.hasAttribute(attr) || el.closest(`[${attr}]`) !== null;
    let n = 0;
    for (const el of sel ? document.querySelectorAll(sel) : []) {
      if (seen(el)) continue;
      el.setAttribute(attr, `${id}-мимо`);
      n++;
    }
    for (const el of document.querySelectorAll("span, p, button, div[role='button']")) {
      if (seen(el)) continue;
      const text = String(el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 40 || !re.test(text)) continue;
      el.setAttribute(attr, `${id}-мимо`);
      n++;
    }
    return n;
  }, [selector, textSource, mark, MARK_ATTR]);
}

/** Клик по помеченной кнопке. Не вышло — ветка просто пропускается, шаг от этого не валится. */
async function clickMarked(page, mark) {
  try {
    await page.locator(`[${MARK_ATTR}="${mark}"]`).first().click({ timeout: CLICK_TIMEOUT_MS });
    return true;
  } catch {
    // Кнопка могла уехать из виду или перерисоваться вместе с веткой.
    return false;
  }
}

/**
 * Ждём, пока в `state.replies` прибавится хоть что-нибудь. Ждать сам ответ бесполезно: пачку
 * дочитывает слушатель, и «пришло» — это прирост, а не факт запроса.
 */
async function waitGrowth(page, state, before, ms = BRANCH_WAIT_MS) {
  const until = Date.now() + ms;
  while (Date.now() < until && state.replies.size === before) await page.waitForTimeout(GROWTH_STEP_MS);
  await page.waitForTimeout(GROWTH_TAIL_MS);
  return state.replies.size > before;
}

/**
 * Раскрыть ветки по очереди и дожать каждую до потолка.
 * `state` — `{ replies: Map, lastParent }`: слушатель площадки кладёт туда пришедшие ответы и
 * пишет, чьи они были последними. `open`/`more` — `{ selector, text }` кнопок площадки.
 * Отдаёт `{ opened, more, timedOut }` — сколько веток раскрыто, сколько раз дожималось «ещё»
 * и упёрлись ли в потолок времени (тогда часть веток осталась нераскрытой).
 */
export async function expandBranches(page, state, { open, more, branches, repliesMax = 20, pauseMs = 700, deadlineMs = BRANCHES_DEADLINE_MS, log } = {}) {
  const countOf = (parent) => [...state.replies.values()].filter((c) => c.parentId === parent).length;
  const until = Date.now() + deadlineMs;
  let opened = 0, dojato = 0, mark = 0, first = true, timedOut = false;

  while (opened < branches) {
    if (Date.now() > until) {
      log?.(`    ветки: время вышло, раскрыто ${opened} из ${branches}`);
      timedOut = true;
      break;
    }
    const button = await markButton(page, open.selector, open.text, ++mark);
    if (!button) break;
    if (first) {
      log?.(`    ветки: первая кнопка нашлась по ${button.how} («${button.text}»)`);
      first = false;
    }
    const before = state.replies.size;
    state.lastParent = null;
    if (!(await clickMarked(page, button.mark))) continue;
    await page.waitForTimeout(pauseMs);
    await waitGrowth(page, state, before);
    opened++;

    for (let round = 0; round < MORE_ROUNDS; round++) {
      // Потолок считается по тому, чьи ответы только что приехали: другого способа узнать,
      // какую ветку мы раскрыли, нет вовсе.
      if (state.lastParent && countOf(state.lastParent) >= repliesMax) break;
      const next = await markButton(page, more.selector, more.text, ++mark);
      if (!next) break;
      const was = state.replies.size;
      if (!(await clickMarked(page, next.mark))) break;
      await page.waitForTimeout(pauseMs);
      dojato++;
      if (!(await waitGrowth(page, state, was))) break;   // прироста нет — ветка кончилась
    }
    await markRest(page, more.selector, more.text, mark);
  }
  return { opened, more: dojato, timedOut };
}

/**
 * Ответы, которые пойдут в базу: только под собранными корневыми и не больше `max` под каждым.
 * Порядок — как приехали: первыми площадка отдаёт то, что показывает первым.
 * Чистая функция, отдельно от браузера: её проверяют тесты.
 */
export function pickReplies(replies, roots, max = 20) {
  const known = new Set([...roots].map((c) => String(c.id)));
  const count = new Map();
  const out = [];
  for (const reply of replies) {
    const parent = reply?.parentId ? String(reply.parentId) : null;
    if (!parent || !known.has(parent)) continue;      // ответ под корневым, который не попал в сбор
    const n = count.get(parent) ?? 0;
    if (n >= max) continue;
    count.set(parent, n + 1);
    out.push(reply);
  }
  return out;
}

/** Сколько веток стоит за этими ответами. */
export const branchesOf = (replies) => new Set(replies.map((r) => r.parentId)).size;
