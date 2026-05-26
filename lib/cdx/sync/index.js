"use strict";

const fs = require("node:fs");
const path = require("node:path");

const engine = require("./engine");
const { localToVault, vaultToLocal } = require("./adapter");
const { createGistBackend } = require("./backends/gist");
const tombstoneStore = require("./tombstones");
const { logEvent } = require("./log");

const ENV_GITHUB_API = "CDX_GITHUB_API";

const SYNC_CONFIG_FILENAME = "sync-config.json";
const CONFIG_VERSION = 1;

const SUPPORTED_BACKENDS = new Set(["gist"]);
const PLANNED_BACKENDS = new Set(["supabase", "firebase"]);

function syncConfigPath(cdxDir) {
  if (typeof cdxDir !== "string" || !cdxDir) {
    throw new Error("cdxDir is required");
  }
  return path.join(cdxDir, SYNC_CONFIG_FILENAME);
}

function loadSyncConfig(cdxDir) {
  const file = syncConfigPath(cdxDir);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (typeof parsed.kind !== "string" || !SUPPORTED_BACKENDS.has(parsed.kind)) {
      return null;
    }
    return {
      version: Number.isInteger(parsed.version) ? parsed.version : CONFIG_VERSION,
      kind: parsed.kind,
      lastSync: typeof parsed.lastSync === "string" ? parsed.lastSync : null,
      login: typeof parsed.login === "string" ? parsed.login : null,
    };
  } catch (_) {
    return null;
  }
}

function saveSyncConfig(cdxDir, config) {
  const file = syncConfigPath(cdxDir);
  if (!config || typeof config !== "object") {
    throw new Error("config object required");
  }
  if (typeof config.kind !== "string" || !SUPPORTED_BACKENDS.has(config.kind)) {
    throw new Error(`unsupported backend kind: ${config.kind}`);
  }
  fs.mkdirSync(cdxDir, { recursive: true });
  const payload = {
    version: CONFIG_VERSION,
    kind: config.kind,
    lastSync: typeof config.lastSync === "string" ? config.lastSync : null,
    login: typeof config.login === "string" ? config.login : null,
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function clearSyncConfig(cdxDir) {
  const file = syncConfigPath(cdxDir);
  if (fs.existsSync(file)) {
    fs.rmSync(file, { force: true });
  }
}

function createBackend(kind, creds, options = {}) {
  if (PLANNED_BACKENDS.has(kind)) {
    throw new Error(`backend '${kind}' is not implemented yet`);
  }
  if (kind !== "gist") {
    throw new Error(`unknown backend kind: ${kind}`);
  }
  const apiBase = typeof options.apiBase === "string" && options.apiBase
    ? options.apiBase
    : (typeof process.env[ENV_GITHUB_API] === "string" && process.env[ENV_GITHUB_API].trim()
        ? process.env[ENV_GITHUB_API].trim().replace(/\/+$/, "")
        : undefined);
  return createGistBackend({
    ...creds,
    fetch: options.fetch,
    apiBase,
  });
}

async function setupSync({ kind, creds, keychain, cdxDir, fetchImpl, apiBase }) {
  if (typeof kind !== "string" || !kind) {
    throw new Error("backend kind required");
  }
  if (!keychain || typeof keychain.setBackendCreds !== "function") {
    throw new Error("keychain instance required");
  }
  const backend = createBackend(kind, creds || {}, { fetch: fetchImpl, apiBase });
  let finalCreds;
  try {
    finalCreds = await backend.init(creds || {});
  } catch (err) {
    logEvent(cdxDir, "error", "setup_failed", { kind, message: err.message, status: err.status });
    throw err;
  }
  await keychain.setBackendCreds(kind, finalCreds);
  saveSyncConfig(cdxDir, {
    kind,
    lastSync: null,
    login: typeof finalCreds.login === "string" ? finalCreds.login : null,
  });
  logEvent(cdxDir, "info", "setup_ok", { kind, login: finalCreds.login });
  return { backend, creds: finalCreds };
}

async function disconnectSync({ keychain, cdxDir, kind }) {
  if (!keychain || typeof keychain.clearBackendCreds !== "function") {
    throw new Error("keychain instance required");
  }
  if (typeof kind === "string" && kind) {
    try {
      await keychain.clearBackendCreds(kind);
    } catch (_) {
      // best-effort
    }
  }
  clearSyncConfig(cdxDir);
  for (const filename of ["tombstones.json", "account-emails.json"]) {
    const fullPath = path.join(cdxDir, filename);
    if (fs.existsSync(fullPath)) {
      try {
        fs.rmSync(fullPath, { force: true });
      } catch (_) {
        // best-effort cleanup
      }
    }
  }
  logEvent(cdxDir, "info", "disconnect", { kind });
}

async function runSync({ keychain, cdxDir, localState, emailExtractor, fetchImpl, apiBase, now }) {
  const config = loadSyncConfig(cdxDir);
  if (!config) {
    throw new Error("sync is not configured for this device");
  }
  const creds = await keychain.getBackendCreds(config.kind);
  if (!creds) {
    throw new Error(`no credentials in keychain for backend '${config.kind}'`);
  }

  const backend = createBackend(config.kind, creds, { fetch: fetchImpl, apiBase });
  const stamp = typeof now === "number" ? now : Date.now();

  const rawTombstones = tombstoneStore.readTombstones(cdxDir);
  const localTombstones = tombstoneStore.cleanupExpired(rawTombstones, stamp);
  if (Object.keys(localTombstones).length !== Object.keys(rawTombstones).length) {
    try {
      tombstoneStore.writeTombstones(cdxDir, localTombstones);
    } catch (_) {
      // tombstone persistence is best-effort
    }
  }

  const localVault = localToVault({
    accounts: localState.accounts || [],
    activeName: localState.activeName || "",
    health: localState.health || {},
    authContents: localState.authContents || {},
    tombstones: localTombstones,
    emailExtractor,
    now: stamp,
  });

  logEvent(cdxDir, "info", "sync_start", { kind: config.kind });
  let syncResult;
  try {
    syncResult = await engine.sync(backend, localVault);
  } catch (err) {
    logEvent(cdxDir, "error", "sync_failed", { message: err.message, status: err.status });
    throw err;
  }
  logEvent(cdxDir, "info", "sync_ok", { action: syncResult.action, remoteVersion: syncResult.remoteVersion });

  const existingAccounts = (localState.accounts || []).map((account) => {
    const auth = (localState.authContents || {})[account.name];
    const email = auth ? toLowerEmail(emailExtractor(auth)) : "";
    return {
      name: account.name,
      path: account.path,
      email,
    };
  });

  const plan = vaultToLocal(syncResult.vault, {
    existingAccounts,
    cdxDir,
  });

  const renames = [];
  for (const planAccount of plan.accounts) {
    const vaultEntry = syncResult.vault.accounts.find((a) => a.email === planAccount.email);
    if (vaultEntry && vaultEntry.name !== planAccount.name) {
      renames.push({ email: planAccount.email, newName: planAccount.name });
    }
  }

  let finalVersion = syncResult.remoteVersion;
  let finalAction = syncResult.action;
  if (renames.length > 0) {
    const renamedAccounts = syncResult.vault.accounts.map((account) => {
      const rename = renames.find((r) => r.email === account.email);
      return rename ? { ...account, name: rename.newName, mtime: stamp } : account;
    });
    const renamedVault = { ...syncResult.vault, accounts: renamedAccounts };
    try {
      finalVersion = await engine.push(backend, renamedVault, syncResult.remoteVersion);
      finalAction = "rename_pushed";
    } catch (_) {
      // best-effort: a concurrent writer raced us. The local rename stays in
      // the plan; the next sync will retry.
    }
  }

  saveSyncConfig(cdxDir, {
    kind: config.kind,
    lastSync: new Date(stamp).toISOString(),
    login: config.login,
  });

  return {
    plan,
    action: finalAction,
    remoteVersion: finalVersion,
  };
}

function toLowerEmail(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase();
}

module.exports = {
  SYNC_CONFIG_FILENAME,
  SUPPORTED_BACKENDS,
  PLANNED_BACKENDS,
  loadSyncConfig,
  saveSyncConfig,
  clearSyncConfig,
  createBackend,
  setupSync,
  disconnectSync,
  runSync,
};
