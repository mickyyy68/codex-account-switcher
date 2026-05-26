"use strict";

const path = require("node:path");
const { emailToSlug } = require("./slug");
const vaultModule = require("./vault");

function localToVault(input) {
  const {
    accounts = [],
    activeName = "",
    health = {},
    authContents = {},
    tombstones = {},
    emailExtractor,
    now = Date.now(),
  } = input || {};
  if (typeof emailExtractor !== "function") {
    throw new Error("emailExtractor function is required");
  }

  const nameToEmail = new Map();
  const vaultAccounts = [];
  const skipped = [];

  for (const account of accounts) {
    if (!account || typeof account.name !== "string" || !account.name) {
      continue;
    }
    const auth = authContents[account.name];
    const email = auth ? toEmail(emailExtractor(auth)) : "";
    if (!email) {
      skipped.push({ name: account.name, reason: auth ? "no_email" : "missing_auth" });
      continue;
    }
    if (nameToEmail.has(account.name)) {
      skipped.push({ name: account.name, reason: "duplicate_name" });
      continue;
    }
    nameToEmail.set(account.name, email);
    vaultAccounts.push({
      email,
      name: account.name,
      pinned: account.pinned === true,
      excluded: account.excludedFromRecommendation === true || account.excluded === true,
      auth,
      mtime: now,
    });
  }

  let active = null;
  if (activeName && nameToEmail.has(activeName)) {
    active = { email: nameToEmail.get(activeName), mtime: now };
  }

  const vaultHealth = {};
  for (const [name, record] of Object.entries(health || {})) {
    const email = nameToEmail.get(name);
    if (!email || !record || typeof record !== "object") {
      continue;
    }
    vaultHealth[email] = { ...record, mtime: now };
  }

  return vaultModule.normalize({
    version: vaultModule.VAULT_VERSION,
    accounts: vaultAccounts,
    active,
    health: vaultHealth,
    deleted: tombstones,
  });
}

function vaultToLocal(vault, options = {}) {
  const normalized = vaultModule.normalize(vault);
  const {
    existingAccounts = [],
    cdxDir,
  } = options;
  if (typeof cdxDir !== "string" || !cdxDir) {
    throw new Error("cdxDir is required");
  }

  const existingByEmail = new Map();
  const existingByName = new Map();
  for (const account of existingAccounts) {
    if (!account || typeof account.name !== "string") {
      continue;
    }
    if (typeof account.email === "string" && account.email) {
      existingByEmail.set(account.email.toLowerCase(), account.name);
    }
    existingByName.set(account.name, account);
  }

  const usedNames = new Set();
  const planAccounts = [];
  const planSnapshots = [];
  const emailToName = new Map();

  const orderedAccounts = [...normalized.accounts].sort((a, b) => {
    const aExisting = existingByEmail.has(a.email) ? 0 : 1;
    const bExisting = existingByEmail.has(b.email) ? 0 : 1;
    return aExisting - bExisting;
  });

  for (const entry of orderedAccounts) {
    if (!entry.auth) {
      continue;
    }
    const desiredName = existingByEmail.get(entry.email) || entry.name || `account-${entry.email.split("@")[0]}`;
    const resolvedName = pickAvailableName(desiredName, usedNames);
    usedNames.add(resolvedName);
    emailToName.set(entry.email, resolvedName);

    const slug = emailToSlug(entry.email);
    const filePath = path.join(cdxDir, "auth", `${slug}.auth.json`);

    planAccounts.push({
      name: resolvedName,
      path: filePath,
      pinned: entry.pinned === true,
      excluded: entry.excluded === true,
      email: entry.email,
    });
    planSnapshots.push({
      path: filePath,
      content: entry.auth,
    });
  }

  const activeName = normalized.active && emailToName.has(normalized.active.email)
    ? emailToName.get(normalized.active.email)
    : "";

  const health = {};
  for (const [email, record] of Object.entries(normalized.health)) {
    const name = emailToName.get(email);
    if (!name || !record || typeof record !== "object") {
      continue;
    }
    const { mtime: _ignored, ...rest } = record;
    health[name] = { ...rest };
  }

  const remainingEmails = new Set(emailToName.keys());
  const accountsToRemove = [];
  for (const account of existingAccounts) {
    if (!account || typeof account.name !== "string") {
      continue;
    }
    const email = typeof account.email === "string" ? account.email.toLowerCase() : "";
    if (!email || !remainingEmails.has(email)) {
      accountsToRemove.push(account.name);
    }
  }

  return {
    accounts: planAccounts,
    activeName,
    health,
    snapshots: planSnapshots,
    accountsToRemove,
  };
}

function pickAvailableName(desired, used) {
  if (!used.has(desired)) {
    return desired;
  }
  let suffix = 2;
  while (used.has(`${desired}-${suffix}`)) {
    suffix += 1;
  }
  return `${desired}-${suffix}`;
}

function toEmail(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(trimmed) ? trimmed : "";
}

module.exports = {
  localToVault,
  vaultToLocal,
};
