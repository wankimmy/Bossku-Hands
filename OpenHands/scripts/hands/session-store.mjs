/**
 * Durable Hands state: one JSON file for sessions and one for settings, both
 * under the Hands data directory. Writes go to a temporary file first and are
 * renamed into place, so a crash mid-write leaves the previous copy intact.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const SESSIONS_FILE = "sessions.json";
const SETTINGS_FILE = "settings.json";

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // Keep the unreadable copy for recovery instead of overwriting it later.
    renameSync(file, `${file}.corrupt-${Date.now()}`);
    return fallback;
  }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    renameSync(temp, file);
  } catch (error) {
    // Windows can refuse the rename while another process (an antivirus scan,
    // say) holds the target open; fall back to an in-place write.
    if (error?.code !== "EPERM" && error?.code !== "EBUSY") throw error;
    writeFileSync(file, readFileSync(temp));
    rmSync(temp, { force: true });
  }
}

export function createSessionStore(dataDir) {
  const sessionsFile = path.join(dataDir, SESSIONS_FILE);
  const settingsFile = path.join(dataDir, SETTINGS_FILE);
  return {
    loadSessions() {
      const value = readJson(sessionsFile, []);
      return Array.isArray(value) ? value : [];
    },
    saveSessions(sessions) {
      writeJson(sessionsFile, sessions);
    },
    loadSettings() {
      const value = readJson(settingsFile, {});
      return value && typeof value === "object" ? value : {};
    },
    saveSettings(settings) {
      writeJson(settingsFile, settings);
    },
  };
}
