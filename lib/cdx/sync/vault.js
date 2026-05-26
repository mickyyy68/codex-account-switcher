"use strict";

const VAULT_VERSION = 1;

function createEmpty() {
  return {
    version: VAULT_VERSION,
    accounts: [],
    active: null,
    health: {},
    deleted: {},
  };
}

function serialize(vault) {
  const normalized = normalize(vault);
  return JSON.stringify(normalized);
}

function deserialize(json) {
  if (typeof json !== "string" || json.length === 0) {
    throw new Error("Remote vault payload is empty.");
  }
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Remote vault is not valid JSON (${err.message}). Did you edit the gist by hand on github.com? Disconnect cloud sync and reconnect to start fresh.`,
    );
  }
  return normalize(parsed);
}

function normalize(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("vault must be an object");
  }
  const version = Number(input.version);
  if (!Number.isInteger(version) || version <= 0) {
    throw new Error("vault must have a positive integer version");
  }
  if (version > VAULT_VERSION) {
    throw new Error(
      `Remote vault was written by a newer version of cdx (vault format v${version}, this build supports up to v${VAULT_VERSION}). Upgrade with: npm i -g codex-account-switcher`,
    );
  }
  if (version !== VAULT_VERSION) {
    throw new Error(`unsupported vault version ${version}`);
  }
  return {
    version,
    accounts: normalizeAccounts(input.accounts),
    active: normalizeActive(input.active),
    health: normalizeHealth(input.health),
    deleted: normalizeDeleted(input.deleted),
  };
}

function normalizeDeleted(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const result = {};
  for (const [email, record] of Object.entries(input)) {
    if (typeof email !== "string" || !email.trim()) {
      continue;
    }
    if (!record || typeof record !== "object") {
      continue;
    }
    result[email.trim().toLowerCase()] = {
      mtime: toMtime(record.mtime),
    };
  }
  return result;
}

function normalizeAccounts(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  const seen = new Set();
  const result = [];
  for (const entry of input) {
    const normalized = normalizeAccount(entry);
    if (!normalized) {
      continue;
    }
    if (seen.has(normalized.email)) {
      continue;
    }
    seen.add(normalized.email);
    result.push(normalized);
  }
  return result;
}

function normalizeAccount(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  if (typeof entry.email !== "string" || !entry.email.trim()) {
    return null;
  }
  return {
    email: entry.email.trim().toLowerCase(),
    name: typeof entry.name === "string" ? entry.name : "",
    pinned: entry.pinned === true,
    excluded: entry.excluded === true,
    auth: entry.auth && typeof entry.auth === "object" ? entry.auth : null,
    mtime: toMtime(entry.mtime),
  };
}

function normalizeActive(input) {
  if (!input || typeof input !== "object") {
    return null;
  }
  if (typeof input.email !== "string" || !input.email.trim()) {
    return null;
  }
  return {
    email: input.email.trim().toLowerCase(),
    mtime: toMtime(input.mtime),
  };
}

function normalizeHealth(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const result = {};
  for (const [email, record] of Object.entries(input)) {
    if (typeof email !== "string" || !email.trim()) {
      continue;
    }
    if (!record || typeof record !== "object") {
      continue;
    }
    result[email.trim().toLowerCase()] = {
      ...record,
      mtime: toMtime(record.mtime),
    };
  }
  return result;
}

function toMtime(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }
  return Math.floor(numeric);
}

module.exports = {
  VAULT_VERSION,
  createEmpty,
  serialize,
  deserialize,
  normalize,
};
