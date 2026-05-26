# cdx (Codex Account Switcher)

Interactive account manager for the [Codex CLI](https://github.com/openai/codex).
Switch between multiple ChatGPT/Codex accounts in one menu, and optionally
sync them across devices via a private GitHub gist.

```bash
cdx
```

Opens the menu:

- **Smart switch** — picks the healthiest account by live limits and switches to it
- **Account list** — Enter activates, Space adds (via Codex login), Tab renames, Del removes
- **Add account** — launches Codex login in your browser and saves the result
- **Connect cloud sync** / **Cloud sync (@your-login)** — see below
- **Exit**

The Account list sorts by remaining 5h limit (most remaining on top) and starts
the cursor on the best candidate. If an email can be extracted from an account's
auth file, `cdx` shows it alongside the local name.

## Install

```bash
npm i -g codex-account-switcher
```

or

```bash
bun add -g codex-account-switcher
```

Commands installed:
- `cdx` — the interactive menu
- `cxs` — alias of `cdx`

## Before first use

Make sure Codex stores auth in a file (`auth.json`):

```bash
codex -c 'cli_auth_credentials_store="file"' login
```

On the first run, `cdx` auto-registers the current Codex auth as account `1` if
it isn't saved yet, then asks you to confirm the name.

## Cloud sync (multi-device)

`cdx` can keep your accounts in sync across multiple computers using a **free,
private GitHub gist** on your own GitHub account. No third-party service to sign
up for, no recurring cost.

### What it does

- On your first PC: `cdx` uploads your accounts to a private gist named
  `cdx-sync vault`. Private = only you (logged into your GitHub) can see it.
- On a new PC: paste the same GitHub token in `cdx` and your accounts appear
  automatically.
- Every time you open `cdx` it does a quick background sync. If you added an
  account on PC A, reopening `cdx` on PC B pulls it in.
- If you delete an account anywhere, a tombstone propagates so it stays
  deleted everywhere.

### Setup (one minute)

1. Open https://github.com/settings/tokens
2. Click **Generate new token → Generate new token (classic)**
3. Set **Note**: `cdx-sync`, **Expiration**: as you prefer
4. Under **Select scopes** tick **only** `gist`
5. Click **Generate token** and copy the `ghp_...` string
6. Run `cdx`, choose **Connect cloud sync**, paste the token, press Enter

The first sync runs immediately. From then on, you see
`cloud@your-login · 2m ago` in the menu header.

### On a new computer

1. Install `cdx` (`npm i -g codex-account-switcher`)
2. Run `cdx`, choose **Connect cloud sync**, paste the **same** token
3. All your accounts are restored

### Disconnect / reconnect

Menu → **Cloud sync (@your-login)** → **Disconnect** → confirm. Removes:
- The local sync configuration (`~/.cdx/sync-config.json`)
- The token from the OS keychain
- Local tombstones and email map

The local Codex accounts stay untouched. The gist on GitHub stays where it is.
Reconnect any time by pasting the same (or a new) token.

> Note: disconnecting only removes the token from this device. To fully revoke
> it, delete the token at https://github.com/settings/tokens.

### What gets synced

- All accounts (name, pinned, excluded flags, raw Codex auth content)
- Currently-active account
- Account health counters used by the auto-cleanup
- Deletion tombstones (so deletes on one device propagate to the others)

### Security model

Your GitHub gist is **private** — only requests authenticated with your token
(or your GitHub session) can read it. The auth tokens inside the gist are
stored as plain JSON. Anyone who can access your GitHub account can read them,
which is the same trust model as anything else in your private GitHub gists.
**Enable 2FA on GitHub** and you're set.

The personal access token you paste is stored in your OS keychain (via
`keytar`): macOS Keychain, Windows Credential Manager, or libsecret on Linux.
On systems without a working keyring (typically: SSH-only Linux servers, WSL2
without setup, Docker), `cdx` falls back to a local file at `~/.cdx/secrets/`
with `chmod 600` and warns you at setup.

### Cost

Free, forever. Realistic data sizes for cdx (~300 KB per ~30 accounts) sit far
below GitHub's gist quotas. Nothing to upgrade, no card to add.

### Where things live

```
~/.cdx/
├── accounts.json            # local account list
├── active                   # active account name
├── auth/*.auth.json         # per-account Codex auth snapshots
├── account-health.json      # local health/cleanup counters
├── account-emails.json      # name→email map (sync helper)
├── tombstones.json          # local deletion markers (sync helper)
├── sync-config.json         # cloud sync config (created after Connect)
├── sync.log                 # JSONL log of sync events (rotates at 1 MB)
└── secrets/                 # token storage fallback when OS keychain is unavailable
```

Plus snapshots created automatically before each sync apply:

```
~/.cdx.bak.YYYYMMDD-HHMMSS/  # rolling backup, last 5 kept
```

### Environment variables

| Variable | What it does |
|---|---|
| `CDX_DIR` | Override the storage directory (default `~/.cdx`) |
| `CODEX_HOME` | Override the Codex auth directory (default `~/.codex`) |
| `CDX_GITHUB_API` | Use a different GitHub API base (e.g. `https://github.acme.com/api/v3` for GitHub Enterprise) |
| `CDX_WEEKLY_OVER_5H_RATIO` | Ratio of weekly-budget capacity over 5h-budget capacity used by Smart switch ranking. Default `7`. Tune higher if you observe weekly empties faster than 5h × 7. |

### Logging

Every sync event is appended as a JSON line to `~/.cdx/sync.log`. Useful when
debugging:

- `setup_ok`, `setup_failed`
- `sync_start`, `sync_ok`, `sync_failed` (with HTTP status when applicable)
- `disconnect`

Tokens and credential fields are automatically redacted before writing.

The file rotates at 1 MB (`sync.log.1` kept).

### Troubleshooting

- **`PAT may be expired or revoked` (401)** — regenerate the PAT at
  github.com/settings/tokens with scope `gist`, then in the menu choose
  **Cloud sync** → **Disconnect** and reconnect with the new token (or accept
  the auto-recovery prompt that `cdx` offers right after the error).
- **`The vault gist no longer exists` (404)** — someone deleted the gist on
  github.com. Accept the auto-recovery prompt or run **Disconnect** →
  reconnect to create a fresh one.
- **`Remote vault is not valid JSON`** — the gist file was hand-edited.
  Disconnect and reconnect; cdx will create a fresh vault from your local
  accounts.
- **`Remote vault was written by a newer version of cdx`** — upgrade with
  `npm i -g codex-account-switcher`.
- **No keychain on Linux / WSL** — `cdx` falls back to file storage at
  `~/.cdx/secrets/` automatically and warns you at setup. Acceptable for
  personal machines; not great for shared servers.

## Legacy import

On first interactive run, `cdx` checks `~/.cdx/accounts.tsv` and imports it
into `~/.cdx/accounts.json`. It writes a marker file when done:

- `~/.cdx/.migration_accounts_tsv_v1.done`

## Notes

- Interactive terminal required (TTY).
- Exit the menu with **Exit** or Ctrl+C.
- `cdx` no longer wraps `codex`. Run `codex` directly when you want to start
  a Codex session; `cdx` is only for managing the accounts and switching
  between them.
