import { describe, expect, it } from 'bun:test';

import { parseRemoteUrl } from '../src/utils/remote-url.ts';

describe('parseRemoteUrl — SCP-style SSH', () => {
  it('parses a github SSH URL with .git suffix', () => {
    expect(parseRemoteUrl('git@github.com:acme/widgets.git')).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
      webUrl: 'https://github.com/acme/widgets',
    });
  });

  it('parses a github SSH URL without .git suffix', () => {
    expect(parseRemoteUrl('git@github.com:acme/widgets')).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
      webUrl: 'https://github.com/acme/widgets',
    });
  });

  it('parses a GH Enterprise SCP-style URL', () => {
    expect(parseRemoteUrl('git@github.example.com:team/repo.git')).toEqual({
      host: 'github.example.com',
      owner: 'team',
      repo: 'repo',
      webUrl: 'https://github.example.com/team/repo',
    });
  });
});

describe('parseRemoteUrl — scheme URLs', () => {
  it('parses an https URL with .git suffix', () => {
    expect(parseRemoteUrl('https://github.com/acme/widgets.git')).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
      webUrl: 'https://github.com/acme/widgets',
    });
  });

  it('parses an https URL without .git suffix', () => {
    expect(parseRemoteUrl('https://github.com/acme/widgets')).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
      webUrl: 'https://github.com/acme/widgets',
    });
  });

  it('strips a trailing slash', () => {
    expect(parseRemoteUrl('https://github.com/acme/widgets/')).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
      webUrl: 'https://github.com/acme/widgets',
    });
  });

  it('parses a GH Enterprise https URL', () => {
    expect(parseRemoteUrl('https://git.example.com/team/repo.git')).toEqual({
      host: 'git.example.com',
      owner: 'team',
      repo: 'repo',
      webUrl: 'https://git.example.com/team/repo',
    });
  });

  it('parses ssh:// scheme URL', () => {
    expect(parseRemoteUrl('ssh://git@github.com/acme/widgets.git')).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
      webUrl: 'https://github.com/acme/widgets',
    });
  });

  it('parses git:// scheme URL', () => {
    expect(parseRemoteUrl('git://github.com/acme/widgets.git')).toEqual({
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
      webUrl: 'https://github.com/acme/widgets',
    });
  });
});

describe('parseRemoteUrl — edge cases', () => {
  it('returns null for empty string', () => {
    expect(parseRemoteUrl('')).toBeNull();
  });

  it('returns null for whitespace', () => {
    expect(parseRemoteUrl('   ')).toBeNull();
  });

  it('returns null for file:// URLs', () => {
    expect(parseRemoteUrl('file:///home/user/repo.git')).toBeNull();
  });

  it('returns null for arbitrary text', () => {
    expect(parseRemoteUrl('just a string')).toBeNull();
  });

  it('returns null for a URL with no owner/repo path', () => {
    expect(parseRemoteUrl('https://github.com/')).toBeNull();
  });

  it('returns null for a URL with just an owner', () => {
    expect(parseRemoteUrl('https://github.com/acme')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    const info = parseRemoteUrl('  https://github.com/acme/widgets.git  ');
    expect(info?.repo).toBe('widgets');
  });

  it('handles a non-string input defensively', () => {
    // TS would catch this, but the function should still not crash.
    expect(parseRemoteUrl(undefined as unknown as string)).toBeNull();
    expect(parseRemoteUrl(null as unknown as string)).toBeNull();
  });
});
