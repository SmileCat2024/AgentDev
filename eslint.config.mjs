import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  // ===== 基础规则 =====
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ===== 全局默认 =====
  {
    rules: {
      'no-undef': 'off',  // TypeScript 项目不需要，Node 全局变量也会误报
    },
  },

  // ===== 全局规则调优（适用所有 .ts 文件）=====
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // — 关闭不适合本项目的推荐规则 —
      'no-undef': 'off',                              // TypeScript 已处理
      '@typescript-eslint/no-explicit-any': 'off',     // 项目大量使用 any
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-expressions': 'off', // 项目有 cond && fn() 模式
      'no-empty': ['warn', { allowEmptyCatch: true }], // 允许空 catch
      '@typescript-eslint/no-this-alias': 'off',       // 存量代码有 self = this
      '@typescript-eslint/no-require-imports': 'off',  // 有动态 require 加载可选依赖

      // — 降级为 warn（代码质量但不阻塞）—
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/ban-ts-comment': ['warn', { 'ts-expect-error': 'allow-with-description' }],
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'prefer-const': ['warn', { destructuring: 'all' }],
      eqeqeq: ['warn', 'always', { null: 'ignore' }],

      // — 保持 error：真正的 bug 捕获 —
      'no-cond-assign': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-duplicate-case': 'error',
      'no-sparse-arrays': 'error',
      'no-unreachable': 'error',
      'no-useless-catch': 'error',
      'no-console': 'off',
      'preserve-caught-error': 'warn',  // ESLint 9+ 新规则，渐进式修复
    },
  },

  // ===== 测试文件进一步放宽 =====
  {
    files: ['**/*.test.ts', '**/test/setup.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'prefer-const': 'off',
    },
  },

  // ===== 忽略 =====
  {
    ignores: [
      'dist/',
      'coverage/',
      'node_modules/',
      '.agentdev/',
      'packages/*/dist/',
      'src/core/viewer-html.ts',
      'vitest.config.ts',
      'scripts/',
      'eslint.config.mjs',
    ],
  },
);
