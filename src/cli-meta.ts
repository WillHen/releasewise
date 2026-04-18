/**
 * CLI metadata helpers. The version string needs special handling:
 * `import pkg from '../package.json'` inlines the version at bundle
 * time, so a released CLI reports whatever version `package.json` held
 * during the last `bun run build`. We read it at runtime instead, with
 * the build-time value as a fallback for `--compile` binaries (no
 * filesystem package.json available).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import pkgBuildTime from '../package.json' with { type: 'json' };

export function resolveVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // Fall through to the build-time version.
  }
  return pkgBuildTime.version;
}
