"use strict";

const fs = require("node:fs");
const path = require("node:path");

const LOG_FILENAME = "sync.log";
const MAX_LOG_BYTES = 1024 * 1024;
const ROTATED_SUFFIX = ".1";

function logFilePath(cdxDir) {
  return path.join(cdxDir, LOG_FILENAME);
}

function rotateIfNeeded(cdxDir, maxBytes = MAX_LOG_BYTES) {
  const file = logFilePath(cdxDir);
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch (_) {
    return;
  }
  if (size < maxBytes) {
    return;
  }
  const rotated = `${file}${ROTATED_SUFFIX}`;
  try {
    fs.rmSync(rotated, { force: true });
    fs.renameSync(file, rotated);
  } catch (_) {
    // rotation is best-effort
  }
}

function logEvent(cdxDir, level, event, data = {}) {
  if (typeof cdxDir !== "string" || !cdxDir) {
    return;
  }
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitize(data),
  };
  let line;
  try {
    line = `${JSON.stringify(payload)}\n`;
  } catch (_) {
    return;
  }
  try {
    fs.mkdirSync(cdxDir, { recursive: true });
    rotateIfNeeded(cdxDir);
    fs.appendFileSync(logFilePath(cdxDir), line, "utf8");
  } catch (_) {
    // logging is best-effort; never throw
  }
}

function sanitize(data) {
  if (!data || typeof data !== "object") {
    return {};
  }
  const result = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "token" || key === "creds") {
      continue;
    }
    if (typeof value === "string" && /^(ghp_|github_pat_)/.test(value)) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

module.exports = {
  logEvent,
  rotateIfNeeded,
  logFilePath,
  LOG_FILENAME,
  MAX_LOG_BYTES,
  ROTATED_SUFFIX,
};
