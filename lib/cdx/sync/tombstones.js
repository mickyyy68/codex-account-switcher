"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TOMBSTONES_FILENAME = "tombstones.json";
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function tombstonesPath(cdxDir) {
  if (typeof cdxDir !== "string" || !cdxDir) {
    throw new Error("cdxDir is required");
  }
  return path.join(cdxDir, TOMBSTONES_FILENAME);
}

function readTombstones(cdxDir) {
  const file = tombstonesPath(cdxDir);
  if (!fs.existsSync(file)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const result = {};
    for (const [email, record] of Object.entries(parsed)) {
      if (typeof email !== "string" || !email.trim()) {
        continue;
      }
      if (!record || typeof record !== "object") {
        continue;
      }
      const mtime = Number(record.mtime);
      if (!Number.isFinite(mtime) || mtime < 0) {
        continue;
      }
      result[email.trim().toLowerCase()] = { mtime: Math.floor(mtime) };
    }
    return result;
  } catch (_) {
    return {};
  }
}

function writeTombstones(cdxDir, tombstones) {
  const file = tombstonesPath(cdxDir);
  fs.mkdirSync(cdxDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(tombstones, null, 2)}\n`, "utf8");
}

function addTombstone(cdxDir, email, now = Date.now()) {
  if (typeof email !== "string" || !email.trim()) {
    return;
  }
  const tombstones = readTombstones(cdxDir);
  tombstones[email.trim().toLowerCase()] = { mtime: now };
  writeTombstones(cdxDir, tombstones);
}

function cleanupExpired(tombstones, now = Date.now(), ttlMs = TOMBSTONE_TTL_MS) {
  const minMtime = now - ttlMs;
  const result = {};
  for (const [email, record] of Object.entries(tombstones || {})) {
    if (record && Number.isFinite(Number(record.mtime)) && Number(record.mtime) >= minMtime) {
      result[email] = record;
    }
  }
  return result;
}

module.exports = {
  readTombstones,
  writeTombstones,
  addTombstone,
  cleanupExpired,
  TOMBSTONES_FILENAME,
  TOMBSTONE_TTL_MS,
};
