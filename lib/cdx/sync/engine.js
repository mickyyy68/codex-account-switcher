"use strict";

const vault = require("./vault");
const { mergeVaults } = require("./merge");
const { VersionConflictError } = require("./backends/interface");

const DEFAULT_MAX_RETRIES = 3;

async function pull(backend) {
  if (!backend || typeof backend.pull !== "function") {
    throw new Error("backend must implement pull()");
  }
  const result = await backend.pull();
  if (!result) {
    return null;
  }
  if (typeof result.blob !== "string" || typeof result.version !== "string") {
    throw new Error("backend.pull() must return { blob: string, version: string }");
  }
  return {
    vault: vault.deserialize(result.blob),
    remoteVersion: result.version,
  };
}

async function push(backend, vaultObj, expectedVersion) {
  if (!backend || typeof backend.push !== "function") {
    throw new Error("backend must implement push()");
  }
  if (expectedVersion !== null && typeof expectedVersion !== "string") {
    throw new Error("expectedVersion must be a string or null");
  }
  const json = vault.serialize(vaultObj);
  const newVersion = await backend.push(json, expectedVersion);
  if (typeof newVersion !== "string") {
    throw new Error("backend.push() must resolve to a version string");
  }
  return newVersion;
}

async function sync(backend, localVault, options = {}) {
  const maxRetries = Number.isInteger(options.maxRetries) && options.maxRetries > 0
    ? options.maxRetries
    : DEFAULT_MAX_RETRIES;

  let attempt = 0;
  while (attempt < maxRetries) {
    attempt += 1;
    const pulled = await pull(backend);

    if (!pulled) {
      const newVersion = await push(backend, localVault, null);
      return {
        vault: vault.normalize(localVault),
        remoteVersion: newVersion,
        action: "initial_push",
      };
    }

    const merged = mergeVaults(localVault, pulled.vault);
    const mergedJson = vault.serialize(merged);
    const remoteJson = vault.serialize(pulled.vault);

    if (mergedJson === remoteJson) {
      return {
        vault: merged,
        remoteVersion: pulled.remoteVersion,
        action: "pulled_only",
      };
    }

    try {
      const newVersion = await push(backend, merged, pulled.remoteVersion);
      return {
        vault: merged,
        remoteVersion: newVersion,
        action: "merged_push",
      };
    } catch (err) {
      if (err instanceof VersionConflictError) {
        if (attempt < maxRetries) {
          continue;
        }
        break;
      }
      throw err;
    }
  }

  throw new Error(`sync exhausted ${maxRetries} retries on version conflicts`);
}

module.exports = {
  pull,
  push,
  sync,
  DEFAULT_MAX_RETRIES,
};
