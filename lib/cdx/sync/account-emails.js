"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ACCOUNT_EMAILS_FILENAME = "account-emails.json";

function filepathFor(cdxDir) {
  if (typeof cdxDir !== "string" || !cdxDir) {
    throw new Error("cdxDir is required");
  }
  return path.join(cdxDir, ACCOUNT_EMAILS_FILENAME);
}

function readEmailMap(cdxDir) {
  const file = filepathFor(cdxDir);
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
    for (const [name, email] of Object.entries(parsed)) {
      if (typeof name !== "string" || !name) {
        continue;
      }
      if (typeof email !== "string" || !email.trim()) {
        continue;
      }
      result[name] = email.trim().toLowerCase();
    }
    return result;
  } catch (_) {
    return {};
  }
}

function writeEmailMap(cdxDir, mapping) {
  const file = filepathFor(cdxDir);
  fs.mkdirSync(cdxDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(mapping, null, 2)}\n`, "utf8");
}

function setEmail(cdxDir, name, email) {
  if (typeof name !== "string" || !name) {
    return;
  }
  if (typeof email !== "string" || !email.trim()) {
    return;
  }
  const map = readEmailMap(cdxDir);
  map[name] = email.trim().toLowerCase();
  writeEmailMap(cdxDir, map);
}

function getEmail(cdxDir, name) {
  if (typeof name !== "string" || !name) {
    return "";
  }
  const map = readEmailMap(cdxDir);
  return map[name] || "";
}

function removeName(cdxDir, name) {
  if (typeof name !== "string" || !name) {
    return;
  }
  const map = readEmailMap(cdxDir);
  if (Object.prototype.hasOwnProperty.call(map, name)) {
    delete map[name];
    writeEmailMap(cdxDir, map);
  }
}

function renameName(cdxDir, oldName, newName) {
  if (typeof oldName !== "string" || !oldName) {
    return;
  }
  if (typeof newName !== "string" || !newName) {
    return;
  }
  const map = readEmailMap(cdxDir);
  if (Object.prototype.hasOwnProperty.call(map, oldName)) {
    map[newName] = map[oldName];
    delete map[oldName];
    writeEmailMap(cdxDir, map);
  }
}

function replaceAll(cdxDir, mapping) {
  if (!mapping || typeof mapping !== "object") {
    return;
  }
  const cleaned = {};
  for (const [name, email] of Object.entries(mapping)) {
    if (typeof name !== "string" || !name) {
      continue;
    }
    if (typeof email !== "string" || !email.trim()) {
      continue;
    }
    cleaned[name] = email.trim().toLowerCase();
  }
  writeEmailMap(cdxDir, cleaned);
}

module.exports = {
  ACCOUNT_EMAILS_FILENAME,
  readEmailMap,
  writeEmailMap,
  setEmail,
  getEmail,
  removeName,
  renameName,
  replaceAll,
};
