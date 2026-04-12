import { describe, expect, it } from 'bun:test';

import {
  createLogger,
  resolveLogLevel,
  type LogLevel,
} from '../src/utils/logger.ts';

function capture(level: LogLevel) {
  let output = '';
  const logger = createLogger(level, (t) => {
    output += t;
  });
  return { logger, output: () => output };
}

describe('createLogger', () => {
  it('step() writes in normal mode', () => {
    const { logger, output } = capture('normal');
    logger.step('Collecting inputs...');
    expect(output()).toContain('Collecting inputs...');
  });

  it('step() is suppressed in quiet mode', () => {
    const { logger, output } = capture('quiet');
    logger.step('Collecting inputs...');
    expect(output()).toBe('');
  });

  it('warn() writes in normal mode', () => {
    const { logger, output } = capture('normal');
    logger.warn('something odd');
    expect(output()).toContain('Warning: something odd');
  });

  it('warn() is suppressed in quiet mode', () => {
    const { logger, output } = capture('quiet');
    logger.warn('something odd');
    expect(output()).toBe('');
  });

  it('debug() only writes in verbose mode', () => {
    const normal = capture('normal');
    normal.logger.debug('detail');
    expect(normal.output()).toBe('');

    const verbose = capture('verbose');
    verbose.logger.debug('detail');
    expect(verbose.output()).toContain('[debug] detail');
  });

  it('error() always writes', () => {
    for (const level of ['quiet', 'normal', 'verbose'] as LogLevel[]) {
      const { logger, output } = capture(level);
      logger.error('bad thing');
      expect(output()).toContain('Error: bad thing');
    }
  });
});

describe('resolveLogLevel', () => {
  it('defaults to normal', () => {
    expect(resolveLogLevel({})).toBe('normal');
  });

  it('quiet wins over verbose', () => {
    expect(resolveLogLevel({ quiet: true, verbose: true })).toBe('quiet');
  });

  it('json implies quiet', () => {
    expect(resolveLogLevel({ json: true })).toBe('quiet');
  });

  it('verbose when only verbose is set', () => {
    expect(resolveLogLevel({ verbose: true })).toBe('verbose');
  });
});
