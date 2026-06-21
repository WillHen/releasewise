/**
 * Simple log-level utility for controlling CLI output verbosity.
 *
 * Three levels:
 *   - `quiet`:   suppress step logs and warnings; only errors and final output.
 *   - `normal`:  default — step logs and warnings, no debug detail.
 *   - `verbose`: everything including debug detail.
 *
 * The logger writes to an injected `stderr` sink so tests can capture output
 * without touching process.stderr.
 *
 * Output is colorized with picocolors when writing to a real terminal. Color
 * is auto-disabled when stderr is not a TTY (piped output, captured in tests),
 * when `NO_COLOR` is set, and re-enabled by `FORCE_COLOR`. Each message is
 * wrapped as a single colored span so the plain text stays contiguous.
 */

import { colorSupported, getColors } from './colors.ts';

export { colorSupported };

export type LogLevel = 'quiet' | 'normal' | 'verbose';

export interface Logger {
  /** Step progress: "Collecting inputs...", "Classifying commits..." */
  step(message: string): void;
  /** Non-fatal warning. */
  warn(message: string): void;
  /** Debug detail — only in verbose mode. */
  debug(message: string): void;
  /** Error — always shown. */
  error(message: string): void;
  /** Current log level. */
  level: LogLevel;
}

export function createLogger(
  level: LogLevel,
  stderr: (text: string) => void = (t) => process.stderr.write(t),
  color: boolean = colorSupported(process.stderr),
): Logger {
  const c = getColors(color);
  return {
    level,
    step(message: string) {
      if (level !== 'quiet') {
        stderr(`  ${c.dim('→')} ${message}\n`);
      }
    },
    warn(message: string) {
      if (level !== 'quiet') {
        stderr(`${c.yellow(`⚠ Warning: ${message}`)}\n`);
      }
    },
    debug(message: string) {
      if (level === 'verbose') {
        stderr(`${c.dim(`[debug] ${message}`)}\n`);
      }
    },
    error(message: string) {
      stderr(`${c.red(c.bold(`✗ Error: ${message}`))}\n`);
    },
  };
}

/**
 * Resolve the effective log level from CLI flags.
 * --quiet wins over --verbose if both are somehow set.
 */
export function resolveLogLevel(opts: {
  quiet?: boolean;
  verbose?: boolean;
  json?: boolean;
}): LogLevel {
  if (opts.quiet || opts.json) return 'quiet';
  if (opts.verbose) return 'verbose';
  return 'normal';
}
