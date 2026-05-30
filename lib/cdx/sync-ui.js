"use strict";

const syncIndex = require("./sync");
const { applyPlan } = require("./sync-apply");

const SETUP_INSTRUCTIONS = [
  "cdx will store your accounts in a *private* GitHub gist on your own",
  "account. Free forever, no extra service to sign up for.",
  "",
  "Security: the gist is private — only you (logged into your GitHub account)",
  "can read it. The PAT is stored in your OS keychain, never on disk in plain.",
  "",
  "1. Open https://github.com/settings/tokens",
  "2. Click 'Generate new token' → 'Generate new token (classic)'",
  "3. Note: 'cdx-sync'   |   Expiration: as you prefer (e.g. No expiration)",
  "4. Scroll to 'Select scopes' and tick ONLY 'gist'",
  "5. Click 'Generate token' at the bottom and copy the ghp_... string",
  "6. Paste it on the next prompt",
  "",
  "On another PC, repeat with the same token — your accounts appear automatically.",
].join("\n");

async function runSetupWizard(p, deps) {
  const kind = "gist";

  if (deps.keychainWarning) {
    p.log.warn(deps.keychainWarning);
    p.log.warn(
      "Your GitHub token will be stored on disk in plain JSON with chmod 600. " +
      "Less secure than the OS keychain, but functional. Press Ctrl+C now to abort if not acceptable.",
    );
  }

  if (typeof p.note === "function") {
    p.note(SETUP_INSTRUCTIONS, "Connect cloud sync (GitHub gist)");
  } else {
    p.log.message(SETUP_INSTRUCTIONS);
  }

  const token = await deps.promptValue(
    p,
    p.password({
      message: "Paste your GitHub personal access token",
      validate: (value) => {
        const trimmed = String(value || "").trim();
        if (!trimmed) {
          return "Token cannot be empty";
        }
        if (!/^(ghp_|github_pat_)/.test(trimmed)) {
          return "That doesn't look like a GitHub PAT (expected ghp_... or github_pat_...)";
        }
        return undefined;
      },
    }),
  );

  const spinner = typeof p.spinner === "function" ? p.spinner() : null;
  if (spinner) {
    spinner.start("Connecting to GitHub...");
  }

  try {
    await syncIndex.setupSync({
      kind,
      creds: { token: String(token).trim() },
      keychain: deps.keychain,
      cdxDir: deps.cdxDir,
    });
  } catch (err) {
    if (spinner) {
      spinner.stop("Setup failed");
    }
    p.log.error(`Setup failed: ${err.message}`);
    return false;
  }

  if (spinner) {
    spinner.stop("Connected");
  }

  p.log.success("Cloud sync connected. Running first sync...");
  await runSyncNow(p, deps, { silent: false });
  return true;
}

async function runSyncNow(p, deps, options = {}) {
  const silent = options.silent === true;
  const interactive = options.interactive !== false;
  const config = syncIndex.loadSyncConfig(deps.cdxDir);
  if (!config) {
    if (!silent) {
      p.log.warn("Cloud sync is not configured on this device.");
    }
    return null;
  }

  if (typeof deps.isOnline === "function") {
    const online = await deps.isOnline();
    if (!online) {
      if (!silent) {
        p.log.warn("You appear to be offline. Skipping sync.");
      }
      return null;
    }
  }

  const spinner = !silent && typeof p.spinner === "function" ? p.spinner() : null;
  if (spinner) {
    spinner.start("Syncing with cloud...");
  }

  let result;
  try {
    const localState = await deps.loadLocalState();
    result = await syncIndex.runSync({
      keychain: deps.keychain,
      cdxDir: deps.cdxDir,
      localState,
      emailExtractor: deps.emailExtractor,
    });
  } catch (err) {
    if (spinner) {
      spinner.stop("Sync failed");
    }
    if (!silent) {
      p.log.error(`Sync failed: ${err.message}`);
    }
    if (interactive && (err.status === 401 || err.status === 404)) {
      await offerRecovery(p, deps, err.status);
    }
    return null;
  }

  try {
    const summary = applyPlan(result.plan, deps.applyDeps);
    if (spinner) {
      spinner.stop("Sync complete");
    }
    if (!silent) {
      const removedNote = summary.removed.length > 0 ? `, removed ${summary.removed.length} stale` : "";
      p.log.success(
        `Synced (${result.action}): ${summary.applied} account${summary.applied === 1 ? "" : "s"}${removedNote}.`,
      );
    }
    return result;
  } catch (err) {
    if (spinner) {
      spinner.stop("Apply failed");
    }
    if (!silent) {
      p.log.error(`Failed to apply synced vault: ${err.message}`);
    }
    return null;
  }
}

async function autoSyncOnOpen(p, deps) {
  return runSyncNow(p, deps, { silent: false, interactive: false });
}

async function offerRecovery(p, deps, status) {
  const message = status === 401
    ? "Looks like the GitHub token was rejected. Reset cloud sync and connect with a new PAT?"
    : "The remote vault gist no longer exists on GitHub. Reset cloud sync and create a fresh one?";
  let confirmed;
  try {
    confirmed = await deps.promptValue(
      p,
      p.confirm({ message, initialValue: true }),
    );
  } catch (_) {
    return false;
  }
  if (!confirmed) {
    return false;
  }
  const config = syncIndex.loadSyncConfig(deps.cdxDir);
  await syncIndex.disconnectSync({
    keychain: deps.keychain,
    cdxDir: deps.cdxDir,
    kind: config ? config.kind : "gist",
  });
  p.log.info("Cloud sync reset. Reconnecting...");
  await runSetupWizard(p, deps);
  return true;
}

async function runDisconnect(p, deps) {
  const config = syncIndex.loadSyncConfig(deps.cdxDir);
  if (!config) {
    p.log.info("Cloud sync is not configured.");
    return false;
  }
  const confirm = await deps.promptValue(
    p,
    p.confirm({
      message: "Disconnect cloud sync on this device? Local accounts stay, and the vault on GitHub stays too.",
      initialValue: false,
    }),
  );
  if (!confirm) {
    p.log.info("Disconnect cancelled.");
    return false;
  }
  await syncIndex.disconnectSync({
    keychain: deps.keychain,
    cdxDir: deps.cdxDir,
    kind: config.kind,
  });
  p.log.success("Cloud sync disconnected on this device.");
  p.log.info(
    "Note: the PAT is removed from this device, but is still valid on GitHub. " +
    "To fully revoke it, delete the token at https://github.com/settings/tokens.",
  );
  return true;
}

function formatLastSyncRelative(lastSync, now = Date.now()) {
  if (!lastSync || typeof lastSync !== "string") {
    return "never";
  }
  const ts = Date.parse(lastSync);
  if (!Number.isFinite(ts)) {
    return "never";
  }
  const deltaMs = Math.max(0, now - ts);
  const seconds = Math.round(deltaMs / 1000);
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

module.exports = {
  runSetupWizard,
  runSyncNow,
  autoSyncOnOpen,
  runDisconnect,
  formatLastSyncRelative,
  SETUP_INSTRUCTIONS,
};
