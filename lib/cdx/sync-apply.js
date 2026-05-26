"use strict";

const fs = require("node:fs");
const path = require("node:path");

function applyPlan(plan, deps) {
  if (!plan || typeof plan !== "object") {
    throw new Error("plan object required");
  }
  if (!deps || typeof deps.writeAccounts !== "function") {
    throw new Error("deps.writeAccounts required");
  }
  if (typeof deps.setActive !== "function" || typeof deps.clearActive !== "function") {
    throw new Error("deps.setActive and deps.clearActive required");
  }
  if (typeof deps.writeAccountHealth !== "function") {
    throw new Error("deps.writeAccountHealth required");
  }

  if (typeof deps.prepareBackup === "function") {
    try {
      deps.prepareBackup();
    } catch (_) {
      // backup is best-effort; never block the apply on it
    }
  }

  for (const snapshot of plan.snapshots || []) {
    if (!snapshot || typeof snapshot.path !== "string") {
      continue;
    }
    fs.mkdirSync(path.dirname(snapshot.path), { recursive: true });
    const payload = typeof snapshot.content === "string"
      ? snapshot.content
      : `${JSON.stringify(snapshot.content, null, 2)}\n`;
    fs.writeFileSync(snapshot.path, payload, "utf8");
    try {
      fs.chmodSync(snapshot.path, 0o600);
    } catch (_) {
      // chmod best-effort on platforms that don't support it
    }
  }

  const accountEntries = (plan.accounts || []).map((account) => ({
    name: account.name,
    path: account.path,
    pinned: account.pinned === true,
    excludedFromRecommendation: account.excluded === true,
  }));
  deps.writeAccounts(accountEntries);

  if (typeof deps.writeAccountEmails === "function") {
    const emailMap = {};
    for (const account of plan.accounts || []) {
      if (account && typeof account.name === "string" && typeof account.email === "string" && account.email) {
        emailMap[account.name] = account.email;
      }
    }
    try {
      deps.writeAccountEmails(emailMap);
    } catch (_) {
      // mapping persistence is best-effort
    }
  }

  if (plan.activeName) {
    deps.setActive(plan.activeName);
  } else {
    deps.clearActive();
  }

  deps.writeAccountHealth(plan.health || {});

  const removed = [];
  for (const name of plan.accountsToRemove || []) {
    if (typeof deps.removeManagedSnapshotForName === "function") {
      try {
        deps.removeManagedSnapshotForName(name);
      } catch (_) {
        // snapshot removal is best-effort
      }
    }
    removed.push(name);
  }

  return { applied: accountEntries.length, removed };
}

module.exports = {
  applyPlan,
};
