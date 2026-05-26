"use strict";

const fs = require("node:fs");
const path = require("node:path");

const BACKUP_SUFFIX = ".bak.";
const DEFAULT_KEEP = 5;

function pad(n) {
  return String(n).padStart(2, "0");
}

function backupTimestamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function backupRoot(cdxDir) {
  return {
    parent: path.dirname(cdxDir),
    name: path.basename(cdxDir),
  };
}

function createBackup(cdxDir, date = new Date()) {
  if (typeof cdxDir !== "string" || !cdxDir) {
    throw new Error("cdxDir is required");
  }
  if (!fs.existsSync(cdxDir)) {
    return null;
  }
  const { parent, name } = backupRoot(cdxDir);
  const stamp = backupTimestamp(date);
  const dest = path.join(parent, `${name}${BACKUP_SUFFIX}${stamp}`);
  copyRecursive(cdxDir, dest);
  return dest;
}

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let entries;
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      try {
        fs.copyFileSync(srcPath, destPath);
        const stat = fs.statSync(srcPath);
        try {
          fs.chmodSync(destPath, stat.mode & 0o777);
        } catch (_) {
          // chmod is best-effort on non-POSIX systems
        }
      } catch (_) {
        // skip files we can't read (best-effort backup)
      }
    }
  }
}

function listBackups(cdxDir) {
  const { parent, name } = backupRoot(cdxDir);
  const prefix = `${name}${BACKUP_SUFFIX}`;
  let entries;
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => {
      const fullPath = path.join(parent, entry.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(fullPath).mtimeMs;
      } catch (_) {
        // skip stat errors
      }
      return { name: entry.name, path: fullPath, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function pruneOldBackups(cdxDir, keep = DEFAULT_KEEP) {
  const all = listBackups(cdxDir);
  const toRemove = all.slice(Math.max(0, keep));
  const removed = [];
  for (const item of toRemove) {
    try {
      fs.rmSync(item.path, { recursive: true, force: true });
      removed.push(item.path);
    } catch (_) {
      // pruning is best-effort
    }
  }
  return removed;
}

module.exports = {
  createBackup,
  pruneOldBackups,
  listBackups,
  BACKUP_SUFFIX,
  DEFAULT_KEEP,
};
