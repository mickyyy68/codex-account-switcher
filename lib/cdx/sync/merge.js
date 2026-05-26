"use strict";

const { normalize, VAULT_VERSION } = require("./vault");

function mergeVaults(local, remote) {
  if (!local || !remote) {
    throw new Error("mergeVaults requires both local and remote vaults");
  }
  const left = normalize(local);
  const right = normalize(remote);
  if (left.version !== right.version) {
    throw new Error(`vault version mismatch: local=${left.version} remote=${right.version}`);
  }
  const deleted = mergeDeleted(left.deleted, right.deleted);
  const allAccounts = mergeAccounts(left.accounts, right.accounts);
  const accounts = allAccounts.filter((account) => {
    const tombstone = deleted[account.email];
    return !tombstone || account.mtime > tombstone.mtime;
  });
  return {
    version: VAULT_VERSION,
    accounts,
    active: mergeActive(left.active, right.active),
    health: mergeHealth(left.health, right.health),
    deleted,
  };
}

function mergeDeleted(localDeleted, remoteDeleted) {
  const emails = new Set([
    ...Object.keys(localDeleted || {}),
    ...Object.keys(remoteDeleted || {}),
  ]);
  const result = {};
  for (const email of emails) {
    const l = (localDeleted || {})[email];
    const r = (remoteDeleted || {})[email];
    if (!l) {
      result[email] = r;
      continue;
    }
    if (!r) {
      result[email] = l;
      continue;
    }
    result[email] = r.mtime >= l.mtime ? r : l;
  }
  return result;
}

function mergeAccounts(localAccounts, remoteAccounts) {
  const winners = new Map();
  for (const account of localAccounts) {
    winners.set(account.email, account);
  }
  for (const account of remoteAccounts) {
    const existing = winners.get(account.email);
    if (!existing || account.mtime >= existing.mtime) {
      winners.set(account.email, account);
    }
  }
  return Array.from(winners.values());
}

function mergeActive(localActive, remoteActive) {
  if (!localActive) {
    return remoteActive;
  }
  if (!remoteActive) {
    return localActive;
  }
  return remoteActive.mtime >= localActive.mtime ? remoteActive : localActive;
}

function mergeHealth(localHealth, remoteHealth) {
  const emails = new Set([
    ...Object.keys(localHealth),
    ...Object.keys(remoteHealth),
  ]);
  const result = {};
  for (const email of emails) {
    const left = localHealth[email];
    const right = remoteHealth[email];
    if (!left) {
      result[email] = right;
      continue;
    }
    if (!right) {
      result[email] = left;
      continue;
    }
    result[email] = right.mtime >= left.mtime ? right : left;
  }
  return result;
}

module.exports = {
  mergeVaults,
};
