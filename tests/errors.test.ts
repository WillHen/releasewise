import { describe, expect, it } from 'bun:test';

import {
  ErrorCodes,
  ReleaseError,
  findReleaseError,
  formatError,
  withStep,
} from '../src/errors.ts';

describe('ReleaseError', () => {
  it('carries code, hint, step, cause, details', () => {
    const cause = new Error('underlying');
    const err = new ReleaseError({
      code: ErrorCodes.GIT_PUSH_FAILED,
      message: 'push failed: boom',
      hint: 'check remote',
      step: 'push',
      cause,
      details: { attempt: 2 },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ReleaseError);
    expect(err.code).toBe(ErrorCodes.GIT_PUSH_FAILED);
    expect(err.hint).toBe('check remote');
    expect(err.step).toBe('push');
    expect(err.cause).toBe(cause);
    expect(err.details).toEqual({ attempt: 2 });
    expect(err.message).toBe('push failed: boom');
    expect(err.name).toBe('ReleaseError');
  });

  it('omits cause when not provided', () => {
    const err = new ReleaseError({
      code: ErrorCodes.UNKNOWN,
      message: 'x',
    });
    expect(err.cause).toBeUndefined();
  });
});

describe('findReleaseError', () => {
  it('returns the error itself when it is a ReleaseError', () => {
    const err = new ReleaseError({
      code: ErrorCodes.UNKNOWN,
      message: 'x',
    });
    expect(findReleaseError(err)).toBe(err);
  });

  it('walks the cause chain', () => {
    const inner = new ReleaseError({
      code: ErrorCodes.CLASSIFIER_PARSE,
      message: 'bad json',
    });
    const outer = new Error('wrapped');
    (outer as Error & { cause?: unknown }).cause = inner;
    expect(findReleaseError(outer)).toBe(inner);
  });

  it('returns null when no ReleaseError in chain', () => {
    const err = new Error('plain');
    expect(findReleaseError(err)).toBeNull();
  });

  it('returns null for non-error inputs', () => {
    expect(findReleaseError(undefined)).toBeNull();
    expect(findReleaseError(null)).toBeNull();
    expect(findReleaseError('some string')).toBeNull();
  });

  it('terminates on self-referential cause chains', () => {
    const err = new Error('cyclic') as Error & { cause?: unknown };
    err.cause = err;
    expect(findReleaseError(err)).toBeNull();
  });
});

describe('withStep', () => {
  it('returns the value on success', async () => {
    const out = await withStep('push', ErrorCodes.GIT_PUSH_FAILED, 'hint', () =>
      Promise.resolve(42),
    );
    expect(out).toBe(42);
  });

  it('wraps a plain Error in a ReleaseError with the step attached', async () => {
    let caught: unknown;
    try {
      await withStep('push', ErrorCodes.GIT_PUSH_FAILED, 'check remote', () => {
        throw new Error('boom');
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ReleaseError);
    const r = caught as ReleaseError;
    expect(r.code).toBe(ErrorCodes.GIT_PUSH_FAILED);
    expect(r.step).toBe('push');
    expect(r.hint).toBe('check remote');
    expect(r.message).toBe('push failed: boom');
    expect((r.cause as Error).message).toBe('boom');
  });

  it('annotates step on a ReleaseError that has none', async () => {
    const inner = new ReleaseError({
      code: ErrorCodes.CLASSIFIER_PARSE,
      message: 'bad json',
    });
    let caught: unknown;
    try {
      await withStep('plan', ErrorCodes.GIT_PUSH_FAILED, undefined, () => {
        throw inner;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(inner);
    expect((caught as ReleaseError).step).toBe('plan');
    // Does NOT replace the original code.
    expect((caught as ReleaseError).code).toBe(ErrorCodes.CLASSIFIER_PARSE);
  });

  it('does not double-wrap a ReleaseError that already has a step', async () => {
    const inner = new ReleaseError({
      code: ErrorCodes.CLASSIFIER_PARSE,
      step: 'classify',
      message: 'bad json',
    });
    let caught: unknown;
    try {
      await withStep('plan', ErrorCodes.GIT_PUSH_FAILED, undefined, () => {
        throw inner;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(inner);
    expect((caught as ReleaseError).step).toBe('classify');
  });
});

describe('formatError normal mode', () => {
  it('prints code + message + hint for a ReleaseError', () => {
    const err = new ReleaseError({
      code: ErrorCodes.GIT_PUSH_FAILED,
      step: 'push',
      message: "push failed: fatal: 'origin' missing",
      hint: 'check your remote',
    });
    const out = formatError(err, { verbose: false });
    expect(out).toContain('Error [ERR_GIT_PUSH_FAILED] during push:');
    expect(out).toContain("push failed: fatal: 'origin' missing");
    expect(out).toContain('Hint: check your remote');
    expect(out).not.toContain('Cause chain:');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('omits "during <step>" when step is absent', () => {
    const err = new ReleaseError({
      code: ErrorCodes.CONFIG_MISSING,
      message: 'no config',
    });
    const out = formatError(err, { verbose: false });
    expect(out).toContain('Error [ERR_CONFIG_MISSING]:');
    expect(out).not.toContain('during');
  });

  it('falls back to ERR_UNKNOWN for plain Errors', () => {
    const out = formatError(new Error('boom'), { verbose: false });
    expect(out).toContain('Error [ERR_UNKNOWN]:');
    expect(out).toContain('boom');
  });

  it('reads code/hint off duck-typed errors (existing custom classes)', () => {
    class Shape extends Error {
      readonly code = 'ERR_API_KEY_MISSING';
      readonly hint = 'set the env var';
    }
    const out = formatError(new Shape('no key'), { verbose: false });
    expect(out).toContain('Error [ERR_API_KEY_MISSING]:');
    expect(out).toContain('no key');
    expect(out).toContain('Hint: set the env var');
  });

  it('indents multi-line messages under the header', () => {
    const err = new ReleaseError({
      code: ErrorCodes.CONFIG_INVALID,
      message: 'line one\nline two',
    });
    const out = formatError(err, { verbose: false });
    const lines = out.split('\n');
    expect(lines[0]).toBe('Error [ERR_CONFIG_INVALID]:');
    expect(lines[1]).toBe('  line one');
    expect(lines[2]).toBe('  line two');
  });
});

describe('formatError verbose mode', () => {
  it('appends the cause chain with stack frames', () => {
    const inner = new Error('underlying');
    const outer = new ReleaseError({
      code: ErrorCodes.GIT_PUSH_FAILED,
      step: 'push',
      message: 'push failed: underlying',
      cause: inner,
    });
    const out = formatError(outer, { verbose: true });
    expect(out).toContain('Cause chain:');
    expect(out).toContain('[0] ReleaseError (ERR_GIT_PUSH_FAILED):');
    expect(out).toContain('[1] Error: underlying');
  });

  it('handles cyclic cause chains without infinite loop', () => {
    const err = new ReleaseError({
      code: ErrorCodes.UNKNOWN,
      message: 'loop',
    });
    (err as unknown as { cause?: unknown }).cause = err;
    const out = formatError(err, { verbose: true });
    expect(out).toContain('Cause chain:');
    // Exited the loop — no explosion.
    expect(out.length).toBeLessThan(10_000);
  });
});
