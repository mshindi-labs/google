/** @type {import('@commitlint/types').UserConfig} */
const config = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'test',
        'chore',
        'perf',
        'ci',
        'revert',
        'build',
      ],
    ],
    'scope-case': [2, 'always', 'kebab-case'],
    'subject-case': [
      2,
      'never',
      ['sentence-case', 'pascal-case', 'upper-case'],
    ],
    'subject-empty': [2, 'never'],
    'header-max-length': [2, 'always', 100],
  },
};

module.exports = config;
