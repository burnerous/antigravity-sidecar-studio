import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { makeHttpError } from './security.mjs';

export const DEFAULT_UI_PREFS = Object.freeze({ skin: 'default', prismVariant: 'auto', motion: 'full' });
export const VALID_UI_SKINS = new Set(['default', 'prism']);
export const VALID_PRISM_VARIANTS = new Set([
  'auto',
  'obsidian-dark',
  'warm-charcoal',
  'daylight-crystal',
  'warm-alabaster',
]);
export const VALID_UI_MOTIONS = new Set(['full', 'reduced']);
export const ALLOWED_UI_PREF_KEYS = new Set(['skin', 'prismVariant', 'motion']);

const validValues = {
  skin: VALID_UI_SKINS,
  prismVariant: VALID_PRISM_VARIANTS,
  motion: VALID_UI_MOTIONS,
};

export function validateUiPrefsPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw makeHttpError(400, 'Invalid UI preferences payload: expected a JSON object');
  }

  const keys = Object.keys(patch);
  const unsupportedKey = keys.find((key) => !ALLOWED_UI_PREF_KEYS.has(key));
  if (unsupportedKey !== undefined) {
    throw makeHttpError(400, `Unsupported UI preference key: ${unsupportedKey}`);
  }

  const validated = {};
  for (const key of keys) {
    const value = patch[key];
    if (typeof value !== 'string' || !validValues[key].has(value)) {
      throw makeHttpError(400, `Invalid ${key} value`);
    }
    validated[key] = value;
  }
  return validated;
}

export function normalizeStoredUiPrefs(raw) {
  try {
    if (raw === null || typeof raw !== 'object') return { ...DEFAULT_UI_PREFS };
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) return { ...DEFAULT_UI_PREFS };

    const prefs = { ...DEFAULT_UI_PREFS };
    for (const [key, allowedValues] of Object.entries(validValues)) {
      if (!Object.hasOwn(raw, key)) continue;
      const value = raw[key];
      if (allowedValues.has(value)) prefs[key] = value;
    }
    return prefs;
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}

export class UiPrefsStore {
  #dataDir;
  #filePath;

  constructor({ dataDir } = {}) {
    this.#dataDir = resolve(dataDir || join(tmpdir(), 'sidecar-studio-data'));
    this.#filePath = join(this.#dataDir, 'ui-prefs.json');
  }

  getFilePath() {
    return this.#filePath;
  }

  load() {
    if (!existsSync(this.#filePath)) return { ...DEFAULT_UI_PREFS };
    try {
      return normalizeStoredUiPrefs(JSON.parse(readFileSync(this.#filePath, 'utf8')));
    } catch {
      return { ...DEFAULT_UI_PREFS };
    }
  }

  update(patch) {
    const validPatch = validateUiPrefsPatch(patch);
    const next = { ...this.load(), ...validPatch };
    mkdirSync(this.#dataDir, { recursive: true });

    const tmpPath = `${this.#filePath}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      renameSync(tmpPath, this.#filePath);
    } finally {
      rmSync(tmpPath, { force: true });
    }
    return { ...next };
  }
}
