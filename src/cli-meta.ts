/**
 * CLI metadata helpers. The version string needs special handling:
 * `import pkg from '../package.json'` inlines the version at bundle
 * time, so a released CLI reports whatever version `package.json` held
 * during the last `bun run build`. We read it at runtime instead, with
 * the build-time value as a fallback for `--compile` binaries (no
 * filesystem package.json available).
 *
 * The `pkgPath` parameter is an optional override used by tests so
 * they can point at a fixture instead of mutating the real repo
 * package.json — callers in `src/index.ts` rely on the default.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import pkgBuildTime from '../package.json' with { type: 'json' };

function defaultPackageJsonPath(): string {
  return fileURLToPath(new URL('../package.json', import.meta.url));
}

export function resolveVersion(pkgPath?: string): string {
  const path = pkgPath ?? defaultPackageJsonPath();
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // Fall through to the build-time version.
  }
  return pkgBuildTime.version;
}
