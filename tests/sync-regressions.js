#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const nodePath = require("node:path");

const {
  createKeychain,
  createMemoryDriver,
  SERVICE,
  backendCredsAccount,
} = require("../lib/cdx/sync/keychain");
const { emailToSlug, MAX_SLUG_LENGTH } = require("../lib/cdx/sync/slug");
const vault = require("../lib/cdx/sync/vault");
const { mergeVaults } = require("../lib/cdx/sync/merge");
const engine = require("../lib/cdx/sync/engine");
const { VersionConflictError } = require("../lib/cdx/sync/backends/interface");
const { createGistBackend, VAULT_FILENAME } = require("../lib/cdx/sync/backends/gist");
const { localToVault, vaultToLocal } = require("../lib/cdx/sync/adapter");
const syncIndex = require("../lib/cdx/sync");
const { applyPlan } = require("../lib/cdx/sync-apply");
const tombstoneStore = require("../lib/cdx/sync/tombstones");
const accountEmails = require("../lib/cdx/sync/account-emails");
const backupModule = require("../lib/cdx/sync/backup");
const { createFileDriver, SECRETS_DIRNAME } = require("../lib/cdx/sync/keychain");
const syncLog = require("../lib/cdx/sync/log");

const FAKE_API = "https://api.example.test";

function fakeEmailExtractor(auth) {
  if (auth && typeof auth === "object" && typeof auth.email === "string") {
    return auth.email;
  }
  return "";
}

function vaultModuleNormalized(accounts) {
  return vault.normalize({ version: vault.VAULT_VERSION, accounts });
}

function mkTempCdxDir() {
  return fs.mkdtempSync(nodePath.join(os.tmpdir(), "cdx-sync-test-"));
}

function createMockFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    const stripped = url.startsWith(FAKE_API) ? url.slice(FAKE_API.length) : url;
    const key = `${method} ${stripped}`;
    calls.push({ method, url: stripped, body: init.body });
    const handler = routes[key];
    if (!handler) {
      throw new Error(`unexpected fetch: ${key}`);
    }
    const response = await handler(init);
    return makeResponse(response || {});
  };
  fetch._calls = calls;
  return fetch;
}

function makeResponse({ status = 200, body = null, statusText = "" } = {}) {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    statusText: statusText || (ok ? "OK" : "Error"),
    async json() {
      return body;
    },
    async text() {
      if (typeof body === "string") {
        return body;
      }
      return JSON.stringify(body);
    },
  };
}

function createFakeBackend({ initialBlob = null, initialVersion = null } = {}) {
  let blob = initialBlob;
  let version = initialVersion;
  let bumpId = initialVersion ? Number(initialVersion.replace(/^v/, "")) || 0 : 0;
  let pushCount = 0;
  let pullCount = 0;
  const onBeforePush = [];

  return {
    async isConfigured() {
      return true;
    },
    async init() {},
    async pull() {
      pullCount += 1;
      if (blob === null) {
        return null;
      }
      return { blob, version };
    },
    async push(newBlob, expectedVersion) {
      pushCount += 1;
      const callbacks = onBeforePush.splice(0, onBeforePush.length);
      for (const cb of callbacks) {
        await cb();
      }
      if (expectedVersion !== version) {
        throw new VersionConflictError();
      }
      blob = newBlob;
      bumpId += 1;
      version = `v${bumpId}`;
      return version;
    },
    _currentVersion() {
      return version;
    },
    _stats() {
      return { pushCount, pullCount };
    },
    _onBeforeNextPush(fn) {
      onBeforePush.push(fn);
    },
  };
}

async function run(name, fn) {
  try {
    await fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (err) {
    process.stderr.write(`not ok - ${name}\n${err.stack || err.message}\n`);
    process.exit(1);
  }
}

async function main() {
  await run("keychain stores backend creds as JSON object", async () => {
    const driver = createMemoryDriver();
    const kc = createKeychain(driver);
    await kc.setBackendCreds("gist", { token: "abc", gistId: "123" });
    const raw = await driver.getPassword(SERVICE, backendCredsAccount("gist"));
    assert.deepEqual(JSON.parse(raw), { token: "abc", gistId: "123" });
  });

  await run("keychain reads back backend creds", async () => {
    const kc = createKeychain(createMemoryDriver());
    await kc.setBackendCreds("gist", { token: "t", gistId: "g" });
    assert.deepEqual(await kc.getBackendCreds("gist"), { token: "t", gistId: "g" });
  });

  await run("keychain returns null for missing backend creds", async () => {
    const kc = createKeychain(createMemoryDriver());
    assert.equal(await kc.getBackendCreds("gist"), null);
  });

  await run("keychain clears backend creds", async () => {
    const kc = createKeychain(createMemoryDriver());
    await kc.setBackendCreds("gist", { token: "t" });
    await kc.clearBackendCreds("gist");
    assert.equal(await kc.getBackendCreds("gist"), null);
  });

  await run("keychain rejects driver without required methods", async () => {
    assert.throws(() => createKeychain(null), /must expose/);
    assert.throws(() => createKeychain({ getPassword: () => null }), /must expose/);
  });

  await run("emailToSlug lowercases and replaces non-alphanumerics", async () => {
    assert.equal(emailToSlug("Foo.Bar+Tag@Example.com"), "foo-bar-tag-example-com");
  });

  await run("emailToSlug truncates long slugs with hash suffix", async () => {
    const long = `${"x".repeat(120)}@example.com`;
    const slug = emailToSlug(long);
    assert.ok(slug.length <= MAX_SLUG_LENGTH);
    assert.match(slug, /-[0-9a-f]{8}$/);
  });

  await run("emailToSlug rejects invalid input", async () => {
    assert.throws(() => emailToSlug(null), /must be a string/);
    assert.throws(() => emailToSlug("noatsign"), /must contain @/);
  });

  await run("vault.createEmpty produces a valid empty vault", async () => {
    const empty = vault.createEmpty();
    assert.equal(empty.version, vault.VAULT_VERSION);
    assert.deepEqual(empty.accounts, []);
    assert.equal(empty.active, null);
    assert.deepEqual(empty.health, {});
  });

  await run("vault.serialize/deserialize round-trip preserves data", async () => {
    const original = {
      version: vault.VAULT_VERSION,
      accounts: [
        { email: "a@b.com", name: "work", pinned: true, excluded: false, auth: { tokens: { access_token: "t" } }, mtime: 100 },
      ],
      active: { email: "a@b.com", mtime: 150 },
      health: { "a@b.com": { strikes: 2, mtime: 175 } },
      deleted: { "old@x.com": { mtime: 50 } },
    };
    const json = vault.serialize(original);
    const restored = vault.deserialize(json);
    assert.deepEqual(restored, original);
  });

  await run("vault.normalize dedupes accounts by email", async () => {
    const normalized = vault.normalize({
      version: vault.VAULT_VERSION,
      accounts: [
        { email: "dup@x.com", name: "first", mtime: 1 },
        { email: "dup@x.com", name: "second", mtime: 2 },
      ],
    });
    assert.equal(normalized.accounts.length, 1);
    assert.equal(normalized.accounts[0].name, "first");
  });

  await run("vault.deserialize rejects newer version with upgrade hint", async () => {
    assert.throws(
      () => vault.deserialize(JSON.stringify({ version: 999, accounts: [] })),
      /newer version of cdx[\s\S]*Upgrade with: npm i -g codex-account-switcher/,
    );
  });

  await run("vault.deserialize gives a friendly hint for hand-edited JSON", async () => {
    assert.throws(
      () => vault.deserialize("{not json}"),
      /not valid JSON[\s\S]*edit the gist by hand/,
    );
  });

  await run("mergeVaults LWW: later mtime wins for accounts", async () => {
    const local = vaultModuleNormalized([{ email: "a@b.com", name: "local", mtime: 100 }]);
    const remote = vaultModuleNormalized([{ email: "a@b.com", name: "remote", mtime: 200 }]);
    const merged = mergeVaults(local, remote);
    assert.equal(merged.accounts[0].name, "remote");
  });

  await run("mergeVaults LWW: remote wins on tie", async () => {
    const local = vaultModuleNormalized([{ email: "a@b.com", name: "local", mtime: 100 }]);
    const remote = vaultModuleNormalized([{ email: "a@b.com", name: "remote", mtime: 100 }]);
    const merged = mergeVaults(local, remote);
    assert.equal(merged.accounts[0].name, "remote");
  });

  await run("mergeVaults unions disjoint emails", async () => {
    const local = vaultModuleNormalized([{ email: "a@b.com", name: "n1", mtime: 1 }]);
    const remote = vaultModuleNormalized([{ email: "c@d.com", name: "n2", mtime: 1 }]);
    const merged = mergeVaults(local, remote);
    assert.equal(merged.accounts.length, 2);
  });

  await run("mergeVaults: tombstone with later mtime excludes the account", async () => {
    const local = vault.normalize({
      version: vault.VAULT_VERSION,
      accounts: [],
      deleted: { "a@b.com": { mtime: 200 } },
    });
    const remote = vault.normalize({
      version: vault.VAULT_VERSION,
      accounts: [{ email: "a@b.com", name: "n", mtime: 100, auth: { x: 1 } }],
    });
    const merged = mergeVaults(local, remote);
    assert.equal(merged.accounts.length, 0);
    assert.equal(merged.deleted["a@b.com"].mtime, 200);
  });

  await run("mergeVaults: account re-added after tombstone resurrects (mtime > tombstone)", async () => {
    const local = vault.normalize({
      version: vault.VAULT_VERSION,
      accounts: [{ email: "a@b.com", name: "n", mtime: 300, auth: { x: 1 } }],
    });
    const remote = vault.normalize({
      version: vault.VAULT_VERSION,
      deleted: { "a@b.com": { mtime: 200 } },
    });
    const merged = mergeVaults(local, remote);
    assert.equal(merged.accounts.length, 1);
    assert.equal(merged.accounts[0].email, "a@b.com");
  });

  await run("mergeVaults: tombstones merge LWW per email", async () => {
    const local = vault.normalize({
      version: vault.VAULT_VERSION,
      deleted: { "a@b.com": { mtime: 100 }, "c@d.com": { mtime: 500 } },
    });
    const remote = vault.normalize({
      version: vault.VAULT_VERSION,
      deleted: { "a@b.com": { mtime: 999 } },
    });
    const merged = mergeVaults(local, remote);
    assert.equal(merged.deleted["a@b.com"].mtime, 999);
    assert.equal(merged.deleted["c@d.com"].mtime, 500);
  });

  await run("mergeVaults LWW: active follows mtime", async () => {
    const local = vault.normalize({ version: vault.VAULT_VERSION, active: { email: "a@b.com", mtime: 100 } });
    const remote = vault.normalize({ version: vault.VAULT_VERSION, active: { email: "c@d.com", mtime: 200 } });
    const merged = mergeVaults(local, remote);
    assert.equal(merged.active.email, "c@d.com");
  });

  await run("engine.pull returns null for empty remote", async () => {
    const backend = createFakeBackend();
    const result = await engine.pull(backend);
    assert.equal(result, null);
  });

  await run("engine.pull deserializes blob and returns version", async () => {
    const backend = createFakeBackend();
    const v = vaultModuleNormalized([{ email: "a@b.com", name: "n", mtime: 1 }]);
    await engine.push(backend, v, null);
    const pulled = await engine.pull(backend);
    assert.equal(pulled.vault.accounts[0].email, "a@b.com");
    assert.equal(typeof pulled.remoteVersion, "string");
  });

  await run("engine.push with version mismatch throws VersionConflictError", async () => {
    const backend = createFakeBackend();
    await engine.push(backend, vault.createEmpty(), null);
    await assert.rejects(() => engine.push(backend, vault.createEmpty(), "v99"), VersionConflictError);
  });

  await run("engine.sync uploads local vault on empty remote", async () => {
    const backend = createFakeBackend();
    const local = vaultModuleNormalized([{ email: "a@b.com", name: "n", mtime: 1 }]);
    const result = await engine.sync(backend, local);
    assert.equal(result.action, "initial_push");
  });

  await run("engine.sync skips push when local has no new info", async () => {
    const backend = createFakeBackend();
    const v = vaultModuleNormalized([{ email: "a@b.com", name: "n", mtime: 100 }]);
    await engine.push(backend, v, null);
    const stats0 = backend._stats();
    const result = await engine.sync(backend, v);
    assert.equal(result.action, "pulled_only");
    assert.equal(backend._stats().pushCount, stats0.pushCount);
  });

  await run("engine.sync merges local changes and pushes", async () => {
    const backend = createFakeBackend();
    await engine.push(backend, vaultModuleNormalized([
      { email: "a@b.com", name: "remote", mtime: 100 },
    ]), null);
    const local = vaultModuleNormalized([
      { email: "a@b.com", name: "local-newer", mtime: 200 },
      { email: "c@d.com", name: "added", mtime: 150 },
    ]);
    const result = await engine.sync(backend, local);
    assert.equal(result.action, "merged_push");
    assert.equal(result.vault.accounts.length, 2);
  });

  await run("engine.sync retries on transient conflict and succeeds", async () => {
    const backend = createFakeBackend();
    await engine.push(backend, vaultModuleNormalized([
      { email: "a@b.com", name: "remote", mtime: 100 },
    ]), null);
    let injected = false;
    backend._onBeforeNextPush(async () => {
      if (injected) return;
      injected = true;
      const concurrent = vaultModuleNormalized([{ email: "a@b.com", name: "concurrent", mtime: 250 }]);
      await engine.push(backend, concurrent, backend._currentVersion());
    });
    const local = vaultModuleNormalized([
      { email: "a@b.com", name: "local", mtime: 200 },
      { email: "new@local.com", name: "fresh", mtime: 150 },
    ]);
    const result = await engine.sync(backend, local);
    assert.equal(result.action, "merged_push");
  });

  await run("engine.sync throws after exhausting retries on persistent conflict", async () => {
    const backend = createFakeBackend();
    await engine.push(backend, vaultModuleNormalized([
      { email: "a@b.com", name: "remote", mtime: 100 },
    ]), null);
    let bump = 1;
    const conflictEveryTime = async () => {
      const concurrent = vaultModuleNormalized([{ email: "a@b.com", name: `c${bump}`, mtime: 100 + bump }]);
      bump += 1;
      await engine.push(backend, concurrent, backend._currentVersion());
      backend._onBeforeNextPush(conflictEveryTime);
    };
    backend._onBeforeNextPush(conflictEveryTime);
    const local = vaultModuleNormalized([
      { email: "a@b.com", name: "local", mtime: 50 },
      { email: "only-local@x.com", name: "fresh", mtime: 250 },
    ]);
    await assert.rejects(
      () => engine.sync(backend, local, { maxRetries: 2 }),
      /exhausted 2 retries/,
    );
  });

  await run("gist backend init creates a gist when none exists", async () => {
    const fetch = createMockFetch({
      "GET /user": () => ({ body: { login: "samu" } }),
      "GET /gists?per_page=100&page=1": () => ({ body: [] }),
      "POST /gists": () => ({ body: { id: "new-gist-id", updated_at: "v0" } }),
    });
    const backend = createGistBackend({ fetch, apiBase: FAKE_API });
    const creds = await backend.init({ token: "ghp_xxx" });
    assert.equal(creds.gistId, "new-gist-id");
  });

  await run("gist backend init discovers existing vault gist by filename", async () => {
    const fetch = createMockFetch({
      "GET /user": () => ({ body: { login: "samu" } }),
      "GET /gists?per_page=100&page=1": () => ({
        body: [{ id: "vault-gist", files: { [VAULT_FILENAME]: {} } }],
      }),
    });
    const backend = createGistBackend({ fetch, apiBase: FAKE_API });
    const creds = await backend.init({ token: "ghp_xxx" });
    assert.equal(creds.gistId, "vault-gist");
  });

  await run("gist backend init throws on 401", async () => {
    const fetch = createMockFetch({
      "GET /user": () => ({ status: 401, body: { message: "Bad credentials" } }),
    });
    const backend = createGistBackend({ fetch, apiBase: FAKE_API });
    await assert.rejects(() => backend.init({ token: "bad" }), /401/);
  });

  await run("gist backend pull returns null when vault file is missing", async () => {
    const fetch = createMockFetch({
      "GET /gists/gid": () => ({ body: { id: "gid", files: { "README.md": {} }, updated_at: "t1" } }),
    });
    const backend = createGistBackend({ fetch, apiBase: FAKE_API, token: "t", gistId: "gid" });
    assert.equal(await backend.pull(), null);
  });

  await run("gist backend pull returns blob + updated_at", async () => {
    const fetch = createMockFetch({
      "GET /gists/gid": () => ({
        body: { id: "gid", files: { [VAULT_FILENAME]: { content: "raw-vault-json" } }, updated_at: "v1" },
      }),
    });
    const backend = createGistBackend({ fetch, apiBase: FAKE_API, token: "t", gistId: "gid" });
    assert.deepEqual(await backend.pull(), { blob: "raw-vault-json", version: "v1" });
  });

  await run("gist backend push with null expectedVersion skips version check", async () => {
    const fetch = createMockFetch({
      "PATCH /gists/gid": () => ({ body: { id: "gid", updated_at: "v-new" } }),
    });
    const backend = createGistBackend({ fetch, apiBase: FAKE_API, token: "t", gistId: "gid" });
    assert.equal(await backend.push("blob", null), "v-new");
  });

  await run("gist backend push throws conflict when updated_at differs", async () => {
    const fetch = createMockFetch({
      "GET /gists/gid": () => ({ body: { id: "gid", files: {}, updated_at: "v-actual" } }),
    });
    const backend = createGistBackend({ fetch, apiBase: FAKE_API, token: "t", gistId: "gid" });
    await assert.rejects(() => backend.push("blob", "v-stale"), VersionConflictError);
  });

  await run("gist backend end-to-end with engine", async () => {
    const remoteState = { files: {}, updated_at: "v0" };
    let bump = 0;
    const fetch = createMockFetch({
      "GET /user": () => ({ body: { login: "samu" } }),
      "GET /gists?per_page=100&page=1": () => ({ body: [] }),
      "POST /gists": () => {
        bump += 1;
        remoteState.updated_at = `v${bump}`;
        return { body: { id: "gid", updated_at: remoteState.updated_at } };
      },
      "GET /gists/gid": () => ({
        body: { id: "gid", files: remoteState.files, updated_at: remoteState.updated_at },
      }),
      "PATCH /gists/gid": (init) => {
        bump += 1;
        const payload = JSON.parse(init.body);
        remoteState.files = { ...remoteState.files, ...payload.files };
        remoteState.updated_at = `v${bump}`;
        return { body: { id: "gid", updated_at: remoteState.updated_at } };
      },
    });

    const backend = createGistBackend({ fetch, apiBase: FAKE_API });
    await backend.init({ token: "ghp_test" });
    const local = vaultModuleNormalized([{ email: "a@b.com", name: "work", mtime: 100 }]);
    const synced = await engine.sync(backend, local);
    assert.equal(synced.action, "initial_push");

    const fresh = createGistBackend({ fetch, apiBase: FAKE_API, token: "ghp_test", gistId: "gid" });
    const pulled = await engine.pull(fresh);
    assert.equal(pulled.vault.accounts[0].email, "a@b.com");
  });

  await run("tombstones round-trip on disk and cleanupExpired drops old entries", async () => {
    const dir = mkTempCdxDir();
    try {
      assert.deepEqual(tombstoneStore.readTombstones(dir), {});
      tombstoneStore.addTombstone(dir, "a@b.com", 1000);
      tombstoneStore.addTombstone(dir, "C@D.com", 2000);
      const stored = tombstoneStore.readTombstones(dir);
      assert.equal(stored["a@b.com"].mtime, 1000);
      assert.equal(stored["c@d.com"].mtime, 2000);

      const cleaned = tombstoneStore.cleanupExpired(stored, 1500 + tombstoneStore.TOMBSTONE_TTL_MS);
      assert.equal(cleaned["a@b.com"], undefined);
      assert.equal(cleaned["c@d.com"].mtime, 2000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run("localToVault propagates tombstones into vault.deleted", async () => {
    const result = localToVault({
      accounts: [],
      authContents: {},
      tombstones: { "x@y.com": { mtime: 7 } },
      emailExtractor: fakeEmailExtractor,
      now: 100,
    });
    assert.equal(result.deleted["x@y.com"].mtime, 7);
  });

  await run("localToVault converts accounts and active to vault model", async () => {
    const result = localToVault({
      accounts: [
        { name: "work", path: "/x/work.json", pinned: true },
      ],
      activeName: "work",
      health: { work: { strikes: 1 } },
      authContents: { work: { email: "work@x.com" } },
      emailExtractor: fakeEmailExtractor,
      now: 1000,
    });
    assert.equal(result.accounts[0].email, "work@x.com");
    assert.equal(result.active.email, "work@x.com");
    assert.equal(result.health["work@x.com"].strikes, 1);
  });

  await run("localToVault skips accounts without extractable email", async () => {
    const result = localToVault({
      accounts: [{ name: "broken", path: "/y.json" }],
      authContents: { broken: { not_email: "x" } },
      emailExtractor: fakeEmailExtractor,
      now: 1,
    });
    assert.equal(result.accounts.length, 0);
  });

  await run("vaultToLocal writes snapshots under cdxDir/auth/<slug>.auth.json", async () => {
    const v = vaultModuleNormalized([
      { email: "a@b.com", name: "work", pinned: true, mtime: 100, auth: { token: "t1" } },
    ]);
    const plan = vaultToLocal(v, { existingAccounts: [], cdxDir: "/home/u/.cdx" });
    assert.equal(plan.accounts[0].path, "/home/u/.cdx/auth/a-b-com.auth.json");
    assert.deepEqual(plan.snapshots[0].content, { token: "t1" });
  });

  await run("vaultToLocal preserves the local name when email is known", async () => {
    const v = vaultModuleNormalized([
      { email: "a@b.com", name: "remote-name", mtime: 100, auth: { x: 1 } },
    ]);
    const plan = vaultToLocal(v, {
      existingAccounts: [{ name: "my-local-name", path: "/old", email: "a@b.com" }],
      cdxDir: "/c",
    });
    assert.equal(plan.accounts[0].name, "my-local-name");
  });

  await run("vaultToLocal disambiguates colliding names across emails", async () => {
    const v = vaultModuleNormalized([
      { email: "a@b.com", name: "main", mtime: 1, auth: { a: 1 } },
      { email: "c@d.com", name: "main", mtime: 1, auth: { b: 1 } },
    ]);
    const plan = vaultToLocal(v, { existingAccounts: [], cdxDir: "/c" });
    const names = plan.accounts.map((a) => a.name).sort();
    assert.deepEqual(names, ["main", "main-2"]);
  });

  await run("vaultToLocal prefers existing local names over new vault accounts on collision", async () => {
    const v = vaultModuleNormalized([
      { email: "fresh@x.com", name: "main", mtime: 200, auth: { fresh: true } },
      { email: "old@x.com", name: "main", mtime: 100, auth: { old: true } },
    ]);
    const plan = vaultToLocal(v, {
      existingAccounts: [{ name: "main", path: "/local/main.json", email: "old@x.com" }],
      cdxDir: "/c",
    });
    const oldEntry = plan.accounts.find((a) => a.email === "old@x.com");
    const freshEntry = plan.accounts.find((a) => a.email === "fresh@x.com");
    assert.equal(oldEntry.name, "main", "the locally-known email should keep the 'main' name");
    assert.equal(freshEntry.name, "main-2", "the new email should be renamed to avoid collision");
  });

  await run("vaultToLocal populates accountsToRemove for locals not in vault", async () => {
    const v = vaultModuleNormalized([
      { email: "kept@x.com", name: "kept", mtime: 1, auth: { a: 1 } },
    ]);
    const plan = vaultToLocal(v, {
      existingAccounts: [
        { name: "kept", path: "/old1", email: "kept@x.com" },
        { name: "gone", path: "/old2", email: "gone@x.com" },
      ],
      cdxDir: "/c",
    });
    assert.deepEqual(plan.accountsToRemove, ["gone"]);
  });

  await run("syncIndex.saveSyncConfig + loadSyncConfig round-trip", async () => {
    const dir = mkTempCdxDir();
    try {
      syncIndex.saveSyncConfig(dir, { kind: "gist", lastSync: "2026-05-26T10:00:00Z" });
      const loaded = syncIndex.loadSyncConfig(dir);
      assert.equal(loaded.kind, "gist");
      assert.equal(loaded.lastSync, "2026-05-26T10:00:00Z");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run("syncIndex persists and reads back the GitHub login", async () => {
    const dir = mkTempCdxDir();
    try {
      syncIndex.saveSyncConfig(dir, { kind: "gist", lastSync: null, login: "samu" });
      const loaded = syncIndex.loadSyncConfig(dir);
      assert.equal(loaded.login, "samu");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run("syncIndex.setupSync persists the login from backend init", async () => {
    const dir = mkTempCdxDir();
    try {
      const fetch = createMockFetch({
        "GET /user": () => ({ body: { login: "alice" } }),
        "GET /gists?per_page=100&page=1": () => ({ body: [] }),
        "POST /gists": () => ({ body: { id: "g", updated_at: "v0" } }),
      });
      const kc = createKeychain(createMemoryDriver());
      await syncIndex.setupSync({
        kind: "gist",
        creds: { token: "ghp_x" },
        keychain: kc,
        cdxDir: dir,
        fetchImpl: fetch,
        apiBase: FAKE_API,
      });
      const cfg = syncIndex.loadSyncConfig(dir);
      assert.equal(cfg.login, "alice");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run("syncIndex.clearSyncConfig removes the file", async () => {
    const dir = mkTempCdxDir();
    try {
      syncIndex.saveSyncConfig(dir, { kind: "gist", lastSync: null });
      syncIndex.clearSyncConfig(dir);
      assert.equal(syncIndex.loadSyncConfig(dir), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run("syncIndex.createBackend rejects unknown kinds", async () => {
    assert.throws(() => syncIndex.createBackend("wat", {}), /unknown backend kind/);
  });

  await run("syncIndex.createBackend signals not-yet-implemented backends", async () => {
    assert.throws(() => syncIndex.createBackend("supabase", {}), /not implemented yet/);
    assert.throws(() => syncIndex.createBackend("firebase", {}), /not implemented yet/);
  });

  await run("syncIndex.setupSync stores creds and config (no passphrase)", async () => {
    const dir = mkTempCdxDir();
    try {
      const fetch = createMockFetch({
        "GET /user": () => ({ body: { login: "samu" } }),
        "GET /gists?per_page=100&page=1": () => ({ body: [] }),
        "POST /gists": () => ({ body: { id: "new-gist", updated_at: "v0" } }),
      });
      const kc = createKeychain(createMemoryDriver());
      const result = await syncIndex.setupSync({
        kind: "gist",
        creds: { token: "ghp_x" },
        keychain: kc,
        cdxDir: dir,
        fetchImpl: fetch,
        apiBase: FAKE_API,
      });
      assert.equal(result.creds.gistId, "new-gist");
      const stored = await kc.getBackendCreds("gist");
      assert.equal(stored.gistId, "new-gist");
      const cfg = syncIndex.loadSyncConfig(dir);
      assert.equal(cfg.kind, "gist");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run("syncIndex.runSync orchestrates full flow without passphrase", async () => {
    const dir = mkTempCdxDir();
    try {
      const remoteState = { files: {}, updated_at: "v0" };
      let bump = 0;
      const fetch = createMockFetch({
        "GET /user": () => ({ body: { login: "samu" } }),
        "GET /gists?per_page=100&page=1": () => ({ body: [] }),
        "POST /gists": () => {
          bump += 1;
          remoteState.updated_at = `v${bump}`;
          return { body: { id: "gid", updated_at: remoteState.updated_at } };
        },
        "GET /gists/gid": () => ({
          body: { id: "gid", files: remoteState.files, updated_at: remoteState.updated_at },
        }),
        "PATCH /gists/gid": (init) => {
          bump += 1;
          const payload = JSON.parse(init.body);
          remoteState.files = { ...remoteState.files, ...payload.files };
          remoteState.updated_at = `v${bump}`;
          return { body: { id: "gid", updated_at: remoteState.updated_at } };
        },
      });

      const kc = createKeychain(createMemoryDriver());
      await syncIndex.setupSync({
        kind: "gist",
        creds: { token: "ghp_x" },
        keychain: kc,
        cdxDir: dir,
        fetchImpl: fetch,
        apiBase: FAKE_API,
      });

      const result = await syncIndex.runSync({
        keychain: kc,
        cdxDir: dir,
        localState: {
          accounts: [{ name: "work", path: "/somewhere/work.auth.json" }],
          activeName: "work",
          health: {},
          authContents: { work: { email: "work@x.com" } },
        },
        emailExtractor: fakeEmailExtractor,
        fetchImpl: fetch,
        apiBase: FAKE_API,
        now: 1700000000000,
      });

      assert.equal(result.action, "initial_push");
      assert.equal(result.plan.activeName, "work");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run("syncIndex.runSync throws when no config exists", async () => {
    const dir = mkTempCdxDir();
    try {
      const kc = createKeychain(createMemoryDriver());
      await assert.rejects(
        () => syncIndex.runSync({
          keychain: kc,
          cdxDir: dir,
          localState: { accounts: [], activeName: "", health: {}, authContents: {} },
          emailExtractor: fakeEmailExtractor,
        }),
        /not configured/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run("syncIndex.runSync: deleting an account locally erases it from the cloud", async () => {
    const dir = mkTempCdxDir();
    try {
      const remoteState = {
        files: {
          ".cdx-vault.json": {
            content: JSON.stringify({
              version: vault.VAULT_VERSION,
              accounts: [
                { email: "a@b.com", name: "main", pinned: false, excluded: false, auth: { tok: 1 }, mtime: 100 },
                { email: "c@d.com", name: "second", pinned: false, excluded: false, auth: { tok: 2 }, mtime: 100 },
              ],
              active: null,
              health: {},
              deleted: {},
            }),
          },
        },
        updated_at: "v-init",
      };

      const fetch = createMockFetch({
        "GET /user": () => ({ body: { login: "samu" } }),
        "GET /gists?per_page=100&page=1": () => ({
          body: [{ id: "gid", files: { ".cdx-vault.json": {} } }],
        }),
        "GET /gists/gid": () => ({
          body: { id: "gid", files: remoteState.files, updated_at: remoteState.updated_at },
        }),
        "PATCH /gists/gid": (init) => {
          const payload = JSON.parse(init.body);
          remoteState.files = { ...remoteState.files, ...payload.files };
          remoteState.updated_at = `${remoteState.updated_at}+`;
          return { body: { id: "gid", updated_at: remoteState.updated_at } };
        },
      });

      const kc = createKeychain(createMemoryDriver());
      await syncIndex.setupSync({
        kind: "gist",
        creds: { token: "ghp_x" },
        keychain: kc,
        cdxDir: dir,
        fetchImpl: fetch,
        apiBase: FAKE_API,
      });

      // User deletes account "main" (a@b.com) locally → records tombstone
      tombstoneStore.addTombstone(dir, "a@b.com", 5000);

      // localState reflects the deletion: "main" account is gone, only "second" remains
      const result = await syncIndex.runSync({
        keychain: kc,
        cdxDir: dir,
        localState: {
          accounts: [{ name: "second", path: "/local/second.json" }],
          activeName: "",
          health: {},
          authContents: { second: { email: "c@d.com", tok: 2 } },
        },
        emailExtractor: fakeEmailExtractor,
        fetchImpl: fetch,
        apiBase: FAKE_API,
        now: 6000,
      });

      // Plan should not contain a@b.com
      const emails = result.plan.accounts.map((a) => a.email).sort();
      assert.deepEqual(emails, ["c@d.com"], "deleted account must not be in the plan");

      // Remote vault should now reflect the tombstone and have only c@d.com
      const remotePayload = JSON.parse(remoteState.files[".cdx-vault.json"].content);
      const remoteEmails = remotePayload.accounts.map((a) => a.email).sort();
      assert.deepEqual(remoteEmails, ["c@d.com"], "remote vault must drop the tombstoned account");
      assert.ok(remotePayload.deleted["a@b.com"], "remote vault must carry the tombstone for the deleted account");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run("gist backend reports friendly error on 401 (expired PAT)", async () => {
    const fetch = createMockFetch({
      "GET /user": () => ({ status: 401, body: { message: "Bad credentials" } }),
    });
    const backend = createGistBackend({ fetch, apiBase: FAKE_API });
    await assert.rejects(() => backend.init({ token: "bad" }), /PAT may be expired or revoked/);
  });

  await run("gist backend reports friendly error on 404 (gist deleted)", async () => {
    const fetch = createMockFetch({
      "GET /gists/gone": () => ({ status: 404, body: { message: "Not Found" } }),
    });
    const backend = createGistBackend({ fetch, apiBase: FAKE_API, token: "t", gistId: "gone" });
    await assert.rejects(() => backend.pull(), /vault gist no longer exists/);
  });

  await run("syncIndex.runSync propagates local renames to the cloud", async () => {
    const dir = mkTempCdxDir();
    try {
      // Step 1: seed the remote vault with a "main" account for fresh@x.com
      const remoteState = {
        files: {
          ".cdx-vault.json": {
            content: JSON.stringify({
              version: vault.VAULT_VERSION,
              accounts: [
                { email: "fresh@x.com", name: "main", pinned: false, excluded: false, auth: { fresh: true }, mtime: 100 },
              ],
              active: null,
              health: {},
            }),
          },
        },
        updated_at: "v-seed",
      };

      const fetch = createMockFetch({
        "GET /user": () => ({ body: { login: "samu" } }),
        "GET /gists?per_page=100&page=1": () => ({
          body: [{ id: "gid", files: { ".cdx-vault.json": {} } }],
        }),
        "GET /gists/gid": () => ({
          body: { id: "gid", files: remoteState.files, updated_at: remoteState.updated_at },
        }),
        "PATCH /gists/gid": (init) => {
          const payload = JSON.parse(init.body);
          remoteState.files = { ...remoteState.files, ...payload.files };
          remoteState.updated_at = `${remoteState.updated_at}+`;
          return { body: { id: "gid", updated_at: remoteState.updated_at } };
        },
      });

      const kc = createKeychain(createMemoryDriver());
      await syncIndex.setupSync({
        kind: "gist",
        creds: { token: "ghp_x" },
        keychain: kc,
        cdxDir: dir,
        fetchImpl: fetch,
        apiBase: FAKE_API,
      });

      // Step 2: local state has "main" for a DIFFERENT email (old@x.com)
      const result = await syncIndex.runSync({
        keychain: kc,
        cdxDir: dir,
        localState: {
          accounts: [{ name: "main", path: "/local/old.auth.json" }],
          activeName: "",
          health: {},
          authContents: { main: { email: "old@x.com", old: true } },
        },
        emailExtractor: fakeEmailExtractor,
        fetchImpl: fetch,
        apiBase: FAKE_API,
        now: 9000000,
      });

      // The local "main" (old@x.com) keeps its name; the cloud "main" (fresh@x.com)
      // gets renamed to "main-2" locally.
      const oldEntry = result.plan.accounts.find((a) => a.email === "old@x.com");
      const freshEntry = result.plan.accounts.find((a) => a.email === "fresh@x.com");
      assert.equal(oldEntry.name, "main");
      assert.equal(freshEntry.name, "main-2");
      assert.equal(result.action, "rename_pushed");

      // The rename was propagated to the gist
      const remotePayload = JSON.parse(remoteState.files[".cdx-vault.json"].content);
      const remoteFresh = remotePayload.accounts.find((a) => a.email === "fresh@x.com");
      const remoteOld = remotePayload.accounts.find((a) => a.email === "old@x.com");
      assert.equal(remoteFresh.name, "main-2", "remote vault must reflect the rename");
      assert.equal(remoteOld.name, "main", "the existing local name stays as 'main' in remote");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run("syncIndex.disconnectSync clears creds, config, tombstones and email map", async () => {
    const dir = mkTempCdxDir();
    try {
      const kc = createKeychain(createMemoryDriver());
      await kc.setBackendCreds("gist", { token: "t", gistId: "g" });
      syncIndex.saveSyncConfig(dir, { kind: "gist", lastSync: null });
      tombstoneStore.addTombstone(dir, "x@y.com", 1000);
      accountEmails.setEmail(dir, "main", "x@y.com");
      await syncIndex.disconnectSync({ keychain: kc, cdxDir: dir, kind: "gist" });
      assert.equal(await kc.getBackendCreds("gist"), null);
      assert.equal(syncIndex.loadSyncConfig(dir), null);
      assert.equal(fs.existsSync(nodePath.join(dir, "tombstones.json")), false);
      assert.equal(fs.existsSync(nodePath.join(dir, "account-emails.json")), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run("sync.log writes JSONL entries and rotates when oversized", async () => {
    const dir = mkTempCdxDir();
    try {
      syncLog.logEvent(dir, "info", "sync_start", { kind: "gist" });
      syncLog.logEvent(dir, "info", "sync_ok", { action: "pulled_only" });
      const file = syncLog.logFilePath(dir);
      const content = fs.readFileSync(file, "utf8").trim().split("\n");
      assert.equal(content.length, 2);
      const first = JSON.parse(content[0]);
      assert.equal(first.event, "sync_start");
      assert.equal(first.kind, "gist");
      assert.ok(typeof first.ts === "string");

      // Force-grow the file beyond MAX_LOG_BYTES then verify rotation
      fs.writeFileSync(file, "x".repeat(syncLog.MAX_LOG_BYTES + 1), "utf8");
      syncLog.logEvent(dir, "info", "after_rotation", {});
      assert.equal(fs.existsSync(`${file}${syncLog.ROTATED_SUFFIX}`), true);
      const fresh = fs.readFileSync(file, "utf8").trim().split("\n");
      assert.equal(fresh.length, 1);
      assert.equal(JSON.parse(fresh[0]).event, "after_rotation");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run("sync.log redacts token-like values from data", async () => {
    const dir = mkTempCdxDir();
    try {
      syncLog.logEvent(dir, "info", "test", {
        token: "ghp_secret",
        creds: { secret: 1 },
        maybeToken: "ghp_AbCdEf",
        safe: "this is fine",
      });
      const content = fs.readFileSync(syncLog.logFilePath(dir), "utf8");
      assert.ok(!content.includes("ghp_secret"));
      assert.ok(!content.includes("ghp_AbCdEf"));
      assert.ok(content.includes("this is fine"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run("syncIndex.createBackend honors CDX_GITHUB_API env var", async () => {
    const prev = process.env.CDX_GITHUB_API;
    process.env.CDX_GITHUB_API = "https://github.acme.com/api/v3";
    try {
      let capturedUrl = "";
      const fetch = async (url) => {
        capturedUrl = url;
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          async json() { return { login: "alice" }; },
          async text() { return ""; },
        };
      };
      const backend = syncIndex.createBackend("gist", { token: "t", gistId: "g" }, { fetch });
      await backend.pull().catch(() => {});
      // The first call goes through the GHE base
      assert.ok(capturedUrl.startsWith("https://github.acme.com/api/v3/"));
    } finally {
      if (prev === undefined) {
        delete process.env.CDX_GITHUB_API;
      } else {
        process.env.CDX_GITHUB_API = prev;
      }
    }
  });

  await run("applyPlan writes snapshots, updates accounts, sets active, removes stale", async () => {
    const dir = mkTempCdxDir();
    try {
      const calls = { writeAccounts: null, setActive: null, removed: [] };
      const deps = {
        writeAccounts: (entries) => { calls.writeAccounts = entries; },
        setActive: (name) => { calls.setActive = name; },
        clearActive: () => {},
        writeAccountHealth: () => {},
        removeManagedSnapshotForName: (name) => { calls.removed.push(name); },
      };
      const snapshotPath = nodePath.join(dir, "auth", "a-b-com.auth.json");
      const plan = {
        accounts: [{ name: "work", path: snapshotPath, pinned: true, excluded: false }],
        activeName: "work",
        health: {},
        snapshots: [{ path: snapshotPath, content: { token: "t1" } }],
        accountsToRemove: ["gone"],
      };
      const summary = applyPlan(plan, deps);
      assert.equal(summary.applied, 1);
      assert.equal(calls.writeAccounts[0].name, "work");
      assert.equal(calls.setActive, "work");
      assert.deepEqual(calls.removed, ["gone"]);
      const written = fs.readFileSync(snapshotPath, "utf8");
      assert.match(written, /"token": "t1"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run("account-emails: setEmail / getEmail / removeName / renameName round-trip", async () => {
    const dir = mkTempCdxDir();
    try {
      assert.equal(accountEmails.getEmail(dir, "work"), "");
      accountEmails.setEmail(dir, "work", "WORK@x.com");
      accountEmails.setEmail(dir, "play", "play@x.com");
      assert.equal(accountEmails.getEmail(dir, "work"), "work@x.com");
      accountEmails.renameName(dir, "work", "office");
      assert.equal(accountEmails.getEmail(dir, "office"), "work@x.com");
      assert.equal(accountEmails.getEmail(dir, "work"), "");
      accountEmails.removeName(dir, "office");
      assert.equal(accountEmails.getEmail(dir, "office"), "");
      assert.equal(accountEmails.getEmail(dir, "play"), "play@x.com");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run("applyPlan writes the email map via deps.writeAccountEmails", async () => {
    const dir = mkTempCdxDir();
    try {
      let captured = null;
      const deps = {
        writeAccounts: () => {},
        setActive: () => {},
        clearActive: () => {},
        writeAccountHealth: () => {},
        removeManagedSnapshotForName: () => {},
        writeAccountEmails: (m) => { captured = m; },
      };
      const plan = {
        accounts: [
          { name: "work", path: "/x/w.json", pinned: false, excluded: false, email: "work@x.com" },
          { name: "play", path: "/x/p.json", pinned: false, excluded: false, email: "play@x.com" },
        ],
        activeName: "",
        health: {},
        snapshots: [],
        accountsToRemove: [],
      };
      applyPlan(plan, deps);
      assert.deepEqual(captured, { work: "work@x.com", play: "play@x.com" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run("backup.createBackup copies cdxDir contents into a sibling .bak.<ts> directory", async () => {
    const dir = mkTempCdxDir();
    try {
      fs.writeFileSync(nodePath.join(dir, "marker.txt"), "hello", "utf8");
      fs.mkdirSync(nodePath.join(dir, "sub"));
      fs.writeFileSync(nodePath.join(dir, "sub", "nested.txt"), "world", "utf8");
      const backupPath = backupModule.createBackup(dir, new Date(Date.UTC(2026, 0, 2, 3, 4, 5)));
      assert.ok(backupPath);
      assert.match(backupPath, /\.bak\.\d{8}-\d{6}$/);
      assert.equal(fs.readFileSync(nodePath.join(backupPath, "marker.txt"), "utf8"), "hello");
      assert.equal(fs.readFileSync(nodePath.join(backupPath, "sub", "nested.txt"), "utf8"), "world");
      fs.rmSync(backupPath, { recursive: true, force: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run("backup.pruneOldBackups keeps the most recent N", async () => {
    const dir = mkTempCdxDir();
    const parent = nodePath.dirname(dir);
    const base = nodePath.basename(dir);
    try {
      const stamps = ["20260101-100000", "20260102-100000", "20260103-100000", "20260104-100000"];
      const backups = stamps.map((stamp, i) => {
        const p = nodePath.join(parent, `${base}.bak.${stamp}`);
        fs.mkdirSync(p, { recursive: true });
        const time = new Date(2026, 0, i + 1).getTime() / 1000;
        fs.utimesSync(p, time, time);
        return p;
      });
      const removed = backupModule.pruneOldBackups(dir, 2);
      assert.equal(removed.length, 2);
      const remaining = backupModule.listBackups(dir);
      assert.equal(remaining.length, 2);
      const remainingNames = remaining.map((b) => b.name).sort();
      assert.deepEqual(remainingNames, [`${base}.bak.20260103-100000`, `${base}.bak.20260104-100000`]);
      for (const p of backups) {
        try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run("applyPlan calls deps.prepareBackup before writing", async () => {
    let backupCalled = false;
    let writeAccountsCalled = false;
    const deps = {
      prepareBackup: () => {
        backupCalled = true;
        if (writeAccountsCalled) {
          throw new Error("prepareBackup must run before writeAccounts");
        }
      },
      writeAccounts: () => { writeAccountsCalled = true; },
      setActive: () => {},
      clearActive: () => {},
      writeAccountHealth: () => {},
      removeManagedSnapshotForName: () => {},
    };
    applyPlan({ accounts: [], activeName: "", health: {}, snapshots: [], accountsToRemove: [] }, deps);
    assert.equal(backupCalled, true);
    assert.equal(writeAccountsCalled, true);
  });

  await run("createFileDriver round-trips get/set/delete on disk with chmod 600", async () => {
    const dir = mkTempCdxDir();
    try {
      const secretsDir = nodePath.join(dir, SECRETS_DIRNAME);
      const driver = createFileDriver(secretsDir);
      assert.equal(await driver.getPassword("svc", "acct"), null);
      await driver.setPassword("svc", "acct", "topsecret");
      assert.equal(await driver.getPassword("svc", "acct"), "topsecret");
      if (process.platform !== "win32") {
        const files = fs.readdirSync(secretsDir);
        assert.equal(files.length, 1);
        const mode = fs.statSync(nodePath.join(secretsDir, files[0])).mode & 0o777;
        assert.equal(mode, 0o600);
      }
      const deleted = await driver.deletePassword("svc", "acct");
      assert.equal(deleted, true);
      assert.equal(await driver.getPassword("svc", "acct"), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run("createFileDriver sanitizes service/account names safely for filenames", async () => {
    const dir = mkTempCdxDir();
    try {
      const driver = createFileDriver(nodePath.join(dir, "secrets"));
      await driver.setPassword("cdx-sync", "backend:gist", "ghp_x");
      const files = fs.readdirSync(nodePath.join(dir, "secrets"));
      assert.equal(files.length, 1);
      assert.match(files[0], /^cdx-sync__backend_gist\.json$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await run("applyPlan clears active when activeName is empty", async () => {
    const dir = mkTempCdxDir();
    try {
      let cleared = 0;
      const deps = {
        writeAccounts: () => {},
        setActive: () => { throw new Error("setActive should not be called"); },
        clearActive: () => { cleared += 1; },
        writeAccountHealth: () => {},
        removeManagedSnapshotForName: () => {},
      };
      applyPlan({ accounts: [], activeName: "", health: {}, snapshots: [], accountsToRemove: [] }, deps);
      assert.equal(cleared, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  process.stdout.write("all sync regression tests passed\n");
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});
