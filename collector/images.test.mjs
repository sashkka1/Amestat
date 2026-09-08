// Проверки перекладывания картинок: пути в бакете и «наш ли адрес».
// Сеть и `.env.local` здесь не трогаются вовсе — адрес проекта передаётся вторым аргументом.

import { test } from "node:test";
import assert from "node:assert/strict";
import { avatarPath, coverPath, publicUrl, isOurs } from "./images.mjs";

const BASE = "https://proba.supabase.co";
const CREATOR = "25140778-7dea-4380-a5c9-7f7148e871ef";

test("пути в бакете: аватар у креатора один, обложка — по id видео", () => {
  assert.equal(avatarPath(CREATOR), `instagram/${CREATOR}/avatar.jpg`);
  assert.equal(coverPath(CREATOR, "3712345678901234567"), `instagram/${CREATOR}/3712345678901234567.jpg`);
});

test("публичный адрес складывается из адреса проекта и пути", () => {
  assert.equal(
    publicUrl(avatarPath(CREATOR), BASE),
    `${BASE}/storage/v1/object/public/avatars/instagram/${CREATOR}/avatar.jpg`,
  );
});

test("isOurs: наш адрес — да, Instagram и пустое — нет", () => {
  assert.equal(isOurs(publicUrl(avatarPath(CREATOR), BASE), BASE), true);
  assert.equal(isOurs("https://instagram.fhel1-1.fna.fbcdn.net/v/t51.jpg?stp=x&oh=y", BASE), false);
  assert.equal(isOurs("https://scontent-hel3-1.cdninstagram.com/v/t51.jpg", BASE), false);
  // Соседний бакет и приватный путь того же проекта нашими не считаются.
  assert.equal(isOurs(`${BASE}/storage/v1/object/public/other/instagram/a.jpg`, BASE), false);
  assert.equal(isOurs(`${BASE}/storage/v1/object/avatars/instagram/a.jpg`, BASE), false);
  assert.equal(isOurs(null, BASE), false);
  assert.equal(isOurs("", BASE), false);
});
