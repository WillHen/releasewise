/**
 * Shared types used across releasewise.
 */

export type BumpType = 'major' | 'minor' | 'patch' | 'none';

export type CommitMode = 'conventional' | 'mixed' | 'manual';

export type ChangelogFormat = 'individual' | 'changelog' | 'both';

export type Tone = 'formal' | 'casual' | 'technical';

export type ProviderName = 'anthropic' | 'openai' | 'groq' | 'gemini';

export interface Commit {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  author: string;
  authorEmail: string;
  date: string;
}

export interface ClassifiedCommit extends Commit {
  bump: BumpType;
  rationale?: string;
  source: 'conventional' | 'ai' | 'manual';
}

export interface RemoteInfo {
  host: string;
  owner: string;
  repo: string;
  /** https URL pointing at the repo root (no trailing .git) */
  webUrl: string;
}

export interface ReleaseNotes {
  /** Keep a Changelog–shaped markdown body, no leading heading */
  body: string;
  /** The title line (e.g., "v1.2.3") */
  title: string;
  /** The `## [x.y.z] - date` style heading for CHANGELOG.md */
  heading: string;
}

export interface AIGenerationResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AIProvider {
  readonly name: ProviderName;
  readonly defaultModel: string;
  generate(opts: {
    system: string;
    user: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<AIGenerationResult>;
  estimateTokens(text: string): number;
}

export interface TransactionLog {
  timestamp: string;
  fromVersion: string;
  toVersion: string;
  bumpCommitSha: string | null;
  tagName: string | null;
  pushed: boolean;
  githubReleaseId: string | null;
  filesModified: string[];
}
