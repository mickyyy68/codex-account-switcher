"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SERVICE = "cdx-sync";
const PASSPHRASE_ACCOUNT = "passphrase";
const SECRETS_DIRNAME = "secrets";

function backendCredsAccount(kind) {
  if (typeof kind !== "string" || !kind) {
    throw new Error("backend kind must be a non-empty string");
  }
  return `backend:${kind}`;
}

function createKeychain(driver) {
  if (
    !driver ||
    typeof driver.getPassword !== "function" ||
    typeof driver.setPassword !== "function" ||
    typeof driver.deletePassword !== "function"
  ) {
    throw new Error("keychain driver must expose getPassword/setPassword/deletePassword");
  }

  return {
    async getPassphrase() {
      return (await driver.getPassword(SERVICE, PASSPHRASE_ACCOUNT)) || null;
    },
    async setPassphrase(passphrase) {
      if (typeof passphrase !== "string" || !passphrase) {
        throw new Error("passphrase must be a non-empty string");
      }
      await driver.setPassword(SERVICE, PASSPHRASE_ACCOUNT, passphrase);
    },
    async clearPassphrase() {
      await driver.deletePassword(SERVICE, PASSPHRASE_ACCOUNT);
    },
    async getBackendCreds(kind) {
      const raw = await driver.getPassword(SERVICE, backendCredsAccount(kind));
      if (!raw) {
        return null;
      }
      try {
        return JSON.parse(raw);
      } catch (_) {
        return null;
      }
    },
    async setBackendCreds(kind, creds) {
      if (!creds || typeof creds !== "object") {
        throw new Error("creds must be an object");
      }
      await driver.setPassword(SERVICE, backendCredsAccount(kind), JSON.stringify(creds));
    },
    async clearBackendCreds(kind) {
      await driver.deletePassword(SERVICE, backendCredsAccount(kind));
    },
  };
}

function loadKeytarDriver() {
  let keytar;
  try {
    keytar = require("keytar");
  } catch (err) {
    throw new Error(`failed to load keytar (${err.message}); install dependencies and ensure OS keychain access`);
  }
  return {
    getPassword: keytar.getPassword.bind(keytar),
    setPassword: keytar.setPassword.bind(keytar),
    deletePassword: keytar.deletePassword.bind(keytar),
  };
}

function defaultKeychain() {
  return createKeychain(loadKeytarDriver());
}

function createMemoryDriver() {
  const store = new Map();
  const keyOf = (service, account) => `${service} ${account}`;
  return {
    async getPassword(service, account) {
      return store.has(keyOf(service, account)) ? store.get(keyOf(service, account)) : null;
    },
    async setPassword(service, account, value) {
      store.set(keyOf(service, account), String(value));
    },
    async deletePassword(service, account) {
      return store.delete(keyOf(service, account));
    },
  };
}

function sanitizeForFilename(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function secretFilePath(secretsDir, service, account) {
  const safe = `${sanitizeForFilename(service)}__${sanitizeForFilename(account)}.json`;
  return path.join(secretsDir, safe);
}

function createFileDriver(secretsDir) {
  if (typeof secretsDir !== "string" || !secretsDir) {
    throw new Error("secretsDir is required");
  }
  return {
    async getPassword(service, account) {
      const file = secretFilePath(secretsDir, service, account);
      try {
        const raw = fs.readFileSync(file, "utf8");
        const parsed = JSON.parse(raw);
        return typeof parsed.value === "string" ? parsed.value : null;
      } catch (_) {
        return null;
      }
    },
    async setPassword(service, account, value) {
      fs.mkdirSync(secretsDir, { recursive: true });
      const file = secretFilePath(secretsDir, service, account);
      fs.writeFileSync(file, `${JSON.stringify({ value: String(value) })}\n`, "utf8");
      try {
        fs.chmodSync(file, 0o600);
      } catch (_) {
        // chmod is best-effort on non-POSIX systems
      }
    },
    async deletePassword(service, account) {
      const file = secretFilePath(secretsDir, service, account);
      if (!fs.existsSync(file)) {
        return false;
      }
      try {
        fs.rmSync(file, { force: true });
        return true;
      } catch (_) {
        return false;
      }
    },
  };
}

async function probeKeytar() {
  let keytar;
  try {
    keytar = require("keytar");
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  try {
    await keytar.getPassword(SERVICE, "__probe__");
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function defaultKeychainWithFallback(cdxDir) {
  const probe = await probeKeytar();
  if (probe.ok) {
    return { keychain: createKeychain(loadKeytarDriver()), kind: "os" };
  }
  if (typeof cdxDir !== "string" || !cdxDir) {
    const err = new Error(`OS keychain unavailable: ${probe.reason}`);
    err.code = "keychain_unavailable";
    throw err;
  }
  const secretsDir = path.join(cdxDir, SECRETS_DIRNAME);
  const driver = createFileDriver(secretsDir);
  return {
    keychain: createKeychain(driver),
    kind: "file",
    reason: probe.reason,
    location: secretsDir,
  };
}

module.exports = {
  createKeychain,
  defaultKeychain,
  defaultKeychainWithFallback,
  createMemoryDriver,
  createFileDriver,
  probeKeytar,
  SERVICE,
  PASSPHRASE_ACCOUNT,
  SECRETS_DIRNAME,
  backendCredsAccount,
};
