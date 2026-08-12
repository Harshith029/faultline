import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import react from 'eslint-plugin-react'

/**
 * Static checks for a plain-JavaScript codebase.
 *
 * Scoped to defects rather than style: undefined identifiers, unused bindings,
 * unreachable code, and React hook misuse. There is no formatter here, because
 * a lint run that mostly reports formatting is a lint run people stop reading.
 */
export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'frontend/dashboard/dist/**',
      'backend/lambda/timelineHandler/dist/**',
      'data/**',
      'dataset/**',
    ],
  },

  js.configs.recommended,

  // Node: agent, core, benchmark, scripts, Lambda.
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // An awaited value inside a loop is usually deliberate here (sequential
      // collection), so this stays off rather than being noise.
      'no-await-in-loop': 'off',
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-throw-literal': 'error',
      'require-atomic-updates': 'error',
    },
  },

  // Browser: dashboard sources.
  {
    files: ['frontend/dashboard/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks, react },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Core no-unused-vars cannot see identifiers used in JSX, so a component
      // that is only rendered would be reported as unused without this.
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // Tests: node:test and vitest globals.
  {
    files: ['**/test/**/*.{js,jsx,mjs}', '**/*.test.{js,jsx,mjs}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser, vi: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
]
