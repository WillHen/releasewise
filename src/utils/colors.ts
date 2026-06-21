/**
 * Shared ANSI color support for CLI output.
 *
 * `colorSupported(stream)` decides whether to emit ANSI escapes, honoring the
 * de-facto `NO_COLOR` / `FORCE_COLOR` env vars and otherwise keying off whether
 * the target stream is an interactive terminal.
 *
 * `getColors(enabled)` returns a picocolors instance; when `enabled` is false
 * every helper is the identity function, so callers can wrap output
 * unconditionally and get plain text when color is off. This keeps the
 * formatters pure: they take an explicit `color` flag (defaulting to off, so
 * snapshot tests stay stable) and the CLI layer decides when to turn it on.
 */
import { createColors } from 'picocolors';

export type Colors = ReturnType<typeof createColors>;

/**
 * Whether ANSI color should be emitted to `stream` (defaults to stdout).
 * `NO_COLOR` forces off; `FORCE_COLOR` forces on unless set to `0`; otherwise
 * color is enabled only for an interactive TTY with a non-dumb terminal.
 */
export function colorSupported(
  stream: { isTTY?: boolean } = process.stdout,
): boolean {
  const env = process.env;
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR) return env.FORCE_COLOR !== '0';
  return Boolean(stream?.isTTY) && env.TERM !== 'dumb';
}

/** A picocolors instance; identity helpers when `enabled` is false. */
export function getColors(enabled: boolean = colorSupported()): Colors {
  return createColors(enabled);
}
