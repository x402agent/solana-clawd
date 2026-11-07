import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

/** Repository-root `.env`, whether this file is loaded from `src/` or `dist/`. */
export function attestationEnvPath(): string {
  return path.resolve(__dirname, '../../.env');
}

/** Trim whitespace, surrounding quotes, and a trailing inline `# comment`. */
export function stripEnvValue(value: string): string {
  let v = value.trim();
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    v = v.slice(1, -1).trim();
  }
  const commentAt = v.search(/\s+#/);
  if (commentAt !== -1) v = v.slice(0, commentAt).trim();
  return v;
}

/**
 * Load the repository-root `.env` into `process.env`. Missing file is the
 * zero-secret demo path. File values win over inherited shell values.
 */
export function loadAttestationEnv(): void {
  const envPath = attestationEnvPath();
  if (!existsSync(envPath)) return;
  const parsed = dotenv.parse(readFileSync(envPath));
  for (const [key, value] of Object.entries(parsed)) {
    process.env[key] = stripEnvValue(value);
  }
}

loadAttestationEnv();
