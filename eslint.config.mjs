// Lints the hand-written code for simple mistakes, with type information. Formatting isn't checked.
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
	{ ignores: ['dist/', 'generated/', 'generated.partial/'] },
	eslint.configs.recommended,
	tseslint.configs.recommendedTypeChecked,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// A leading `_` marks a name that is unused on purpose.
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
			],
			// The test runner handles the promise each test returns.
			'@typescript-eslint/no-floating-promises': [
				'error',
				{ allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'describe', 'it', 'suite'] }] },
			],
		},
	},
	{
		// These read the OpenAPI document, whose nodes are `Schema`, typed by shape as `any`.
		files: ['generator/conformance.ts', 'generator/patches.ts', 'generator/prepare.ts', 'generator/spec.ts', 'test/prepare.test.ts'],
		rules: {
			'@typescript-eslint/no-unsafe-argument': 'off',
			'@typescript-eslint/no-unsafe-assignment': 'off',
			'@typescript-eslint/no-unsafe-call': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off',
			'@typescript-eslint/no-unsafe-return': 'off',
		},
	},
	{
		files: ['test/**/*.ts'],
		rules: {
			// A mock of fetch is async to return a promise, as fetch does.
			'@typescript-eslint/require-await': 'off',
		},
	},
	{
		// Compile-time checks, which name values only to read their types.
		files: ['test/types.ts'],
		rules: {
			'@typescript-eslint/no-unused-vars': 'off',
		},
	},
	{
		// Configuration files aren't in a tsconfig.
		files: ['**/*.mjs'],
		extends: [tseslint.configs.disableTypeChecked],
	},
);
