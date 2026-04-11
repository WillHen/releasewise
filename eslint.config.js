// ESLint flat config for releasewise.
// Keep this file small: default recommended rules from @eslint/js and
// typescript-eslint, plus a few project-specific tweaks, plus
// eslint-config-prettier to turn off anything that would fight Prettier.
import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'tests/e2e/fixture-repo/**',
      '*.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Enforce type-only imports where possible — matches our style and
      // avoids accidental runtime imports of pure types.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // Flag unused vars, but allow a leading underscore escape hatch for
      // intentional ignores (e.g. unused callback params).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // `any` is a code smell but not always avoidable in adapter layers;
      // warn rather than error so we can triage case-by-case.
      '@typescript-eslint/no-explicit-any': 'warn',
      // We do want `console.log` in the CLI — it's how we talk to users.
      'no-console': 'off',
    },
  },
  // MUST be last: turns off all rules that conflict with Prettier.
  eslintConfigPrettier,
);
