"use strict";

const crypto = require("node:crypto");

const MAX_SLUG_LENGTH = 64;
const HASH_SUFFIX_LENGTH = 8;

function emailToSlug(email) {
  if (typeof email !== "string") {
    throw new Error("email must be a string");
  }
  const trimmed = email.trim().toLowerCase();
  if (!trimmed || !trimmed.includes("@")) {
    throw new Error("email must contain @");
  }

  const base = trimmed
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) {
    throw new Error("email produced an empty slug");
  }

  if (base.length <= MAX_SLUG_LENGTH) {
    return base;
  }

  const hash = crypto.createHash("sha256").update(trimmed).digest("hex").slice(0, HASH_SUFFIX_LENGTH);
  const head = base.slice(0, MAX_SLUG_LENGTH - HASH_SUFFIX_LENGTH - 1).replace(/-+$/, "");
  return `${head}-${hash}`;
}

module.exports = {
  emailToSlug,
  MAX_SLUG_LENGTH,
};
