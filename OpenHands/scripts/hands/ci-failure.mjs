/**
 * Reading a failed CI run: is it the code's fault, and is it the same failure
 * as last time?
 *
 * Infrastructure failures (a lost runner, a network error, a cancelled or
 * timed-out job) are not fixed by editing source, so Hands escalates them
 * instead of calling the coder. The signature ignores numbers, hashes and
 * paths, so a repeat of the same failure is recognised even when line numbers,
 * durations or temp folders differ between runs.
 */

import { createHash } from "node:crypto";

const INFRA_CONCLUSIONS = new Set([
  "cancelled",
  "timed_out",
  "startup_failure",
  "stale",
  "skipped",
]);

const INFRA_PATTERNS = [
  /runner has received a shutdown signal/i,
  /lost communication with the server/i,
  /the operation was canceled/i,
  /no space left on device/i,
  /\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND)\b/,
  /could not resolve host/i,
  /\b(502|503|504) (bad gateway|service unavailable|gateway time-?out)/i,
  /api rate limit exceeded/i,
  /job was not acquired by runner/i,
];

const isInfrastructure = (failure) =>
  INFRA_CONCLUSIONS.has(String(failure?.conclusion ?? "").toLowerCase()) ||
  INFRA_PATTERNS.some((pattern) =>
    pattern.test(String(failure?.summary ?? "")),
  );

/** "infrastructure" when every failed job failed for an infrastructure reason. */
export function classifyCiFailure(failures) {
  const list = Array.isArray(failures) ? failures : [];
  if (list.length > 0 && list.every(isInfrastructure)) return "infrastructure";
  return "code";
}

function firstErrorLine(summary) {
  const lines = String(summary ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.find((line) => /error|fail|expected|assert|exception/i.test(line)) ??
    lines[0] ??
    ""
  );
}

const normalise = (line) =>
  line
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, "<hash>")
    .replace(/([a-z]:)?[\\/][^\s:'"]+/gi, "<path>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ");

// Well-known token shapes, masked wherever they appear.
const TOKEN_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\blin_api_[A-Za-z0-9]{20,}\b/g,
];
// `key=value` / `key: value` pairs whose value is a credential. The key may
// carry `_`/`-` separated words around the secret word (GH_TOKEN,
// DB_PASSWORD, LINEAR_API_KEY), but "tokenizer" is not a secret key.
const KEY_VALUE_PATTERN =
  /\b((?:[A-Za-z0-9]+[_-])*(?:token|password|passwd|secret|api[_-]?key|access[_-]?key)(?:[_-][A-Za-z0-9]+)*)(\s*[:=]\s*)([^\s'"]{6,})/gi;
const BEARER_PATTERN = /\b(bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi;
// `https://user:token@host/...` -> `https://host/...`
const URL_CREDENTIALS_PATTERN = /\b(https?:\/\/)[^\s/@'"]+@/gi;

/** Removes the `user:password@` part of every http(s) URL in `text`. */
export function stripUrlCredentials(text) {
  return String(text ?? "").replace(URL_CREDENTIALS_PATTERN, "$1");
}

/** Masks tokens and credentials so logs and errors can be stored or shown to a model. */
export function redactSecrets(text) {
  let value = stripUrlCredentials(text);
  for (const pattern of TOKEN_PATTERNS)
    value = value.replace(pattern, "[REDACTED]");
  return value
    .replace(
      KEY_VALUE_PATTERN,
      (_match, key, separator) => `${key}${separator}[REDACTED]`,
    )
    .replace(BEARER_PATTERN, (_match, prefix) => `${prefix}[REDACTED]`);
}

/** Keeps only the fields Hands uses, bounded in size and with secrets masked. */
export function sanitizeFailures(failures) {
  return (Array.isArray(failures) ? failures : [])
    .slice(0, 20)
    .map((failure) => ({
      name: String(failure?.name ?? "unknown").slice(0, 200),
      conclusion: String(failure?.conclusion ?? "failure").slice(0, 50),
      summary: redactSecrets(String(failure?.summary ?? "").slice(0, 8000)),
    }));
}

/** A short stable id for "these jobs failed with this error". */
export function failureSignature(failures) {
  const parts = (Array.isArray(failures) ? failures : [])
    .map(
      (failure) =>
        `${failure?.name ?? ""}::${normalise(firstErrorLine(failure?.summary))}`,
    )
    .sort();
  return createHash("sha256")
    .update(parts.join("\n"))
    .digest("hex")
    .slice(0, 16);
}
