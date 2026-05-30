# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] / 0.3.0

### Added

- **Smart switch v2**: new ranking algorithm that maximises how long an
  account can be used *right now* before either limit runs out. Score is
  `min(hours_5h_remaining, hours_weekly_remaining)` where the weekly cap is
  modeled as `W × 5h` hours (default `W=7`, configurable via
  `CDX_WEEKLY_OVER_5H_RATIO`). Fixes the issue where a 80% 5h / 2% weekly
  account was preferred over a 20% 5h / 90% weekly one — the new algorithm
  correctly favours the latter.
- **Both 5h and weekly limits visible inline** in Account list for each
  account, with semaphore colors (green/yellow/red).
- **Cloud sync** across devices via a private GitHub gist (free, no
  third-party service). Paste a `gist`-scoped PAT once per device; the menu
  header shows `cloud@your-login · <relative time>` when configured. See the
  README for the full setup walkthrough.
- **Tombstones**: deleting an account anywhere propagates the deletion to all
  other devices on the next sync. Auto-cleaned after 30 days. Re-adding an
  account with the same email transparently resurrects it.
- **Email collision handling**: when the cloud has an account whose name
  already exists locally (different emails), the local name keeps priority
  and the new one gets a `-2`/`-3`/... suffix. The rename is then
  propagated back to the gist so all devices agree.
- **Local backup before every sync apply**: snapshots `~/.cdx/` to
  `~/.cdx.bak.YYYYMMDD-HHMMSS/`, keeps the last 5.
- **Auto-recovery prompt** on HTTP 401 (expired PAT) and 404 (gist deleted):
  one-click reset → re-run the connect wizard.
- **Keychain fallback to disk** (`~/.cdx/secrets/`, `chmod 600`) when the OS
  keychain is unavailable (typical case: SSH-only Linux servers, WSL2,
  Docker). Warning shown at setup.
- **GitHub Enterprise support** via `CDX_GITHUB_API` env var.
- **Sync logging** to `~/.cdx/sync.log` (JSONL, rotates at 1 MB). Tokens
  redacted automatically.
- **Disconnect now reminds** that the PAT is still valid on github.com and
  needs to be revoked there to be fully invalidated.

### Changed

- **`cdx` is now the menu, not a wrapper.** Running `cdx` opens the interactive
  account manager directly; it no longer forwards arguments to `codex`. Run
  `codex` yourself for Codex sessions. The `cdx manual` subcommand is removed
  (`cdx` does what `cdx manual` used to do).
- The menu adapts to whether cloud sync is configured: shows
  **Connect cloud sync** when not configured, **Cloud sync (@login)** when
  configured (opening Sync now / Disconnect / Back).

### Removed

- **`ccx` binary** and the entire transparent-codex-wrapper code path
  (`lib/ccx/`, `lib/cdx/wrapper.js`, `lib/cdx/settings.js`). The wrapper is
  out of scope for this tool — `codex` is launched directly by the user.
- **CDX settings menu** (including Access mode). Was only useful for the
  wrapper.
- **`cdx smart-switch --json`** non-interactive subcommand. The interactive
  Smart switch in the menu replaces it.
- **`node-pty` dependency**: was only used by the wrapper.

### Fixed

- Removed account no longer "resurrects" after a sync (tombstones).
- The local name of an account is preserved across syncs when its email
  is already known on this device.
- Clearer, actionable error messages for: expired PAT (401), gist deleted
  (404), insufficient scope (403), hand-edited gist JSON, vault from a newer
  cdx version.

### Security

- The vault is **not** encrypted at rest in the gist. It relies on the gist
  being private and on your GitHub account security (use 2FA). This is the
  same trust model as any private gist on your account. The PAT itself is
  stored only in the OS keychain (or in a `chmod 600` file when the OS
  keychain is unavailable), never written to disk in plain text by accident.
- Tokens are automatically redacted from `sync.log`.

## [0.2.0]

Prior to this changelog.
