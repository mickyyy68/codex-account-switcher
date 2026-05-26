"use strict";

/**
 * @typedef {object} BackendPullResult
 * @property {string} blob     - serialized vault payload (JSON produced by vault.serialize)
 * @property {string} version  - opaque backend version (ETag, updated_at, etc.)
 */

/**
 * @typedef {object} SyncBackend
 * @property {() => Promise<boolean>} isConfigured
 * @property {(creds: object) => Promise<object>} init
 *   Validates creds, tests connection, bootstraps backend-side storage,
 *   and returns the completed credentials to persist (e.g. resolved gistId,
 *   discovered project ref). The returned creds are what should be saved.
 * @property {() => Promise<BackendPullResult|null>} pull
 *   Resolves to null when no remote blob exists yet.
 * @property {(blob: string, expectedVersion: string|null) => Promise<string>} push
 *   Throws VersionConflictError when expectedVersion does not match the current
 *   remote version. Resolves to the new version on success.
 */

class VersionConflictError extends Error {
  constructor(message = "remote version mismatch") {
    super(message);
    this.name = "VersionConflictError";
    this.code = "version_conflict";
  }
}

module.exports = {
  VersionConflictError,
};
