import { describe, expect, it } from 'vitest'
import { canChangeWhatRuns, isCodeLoading } from '../../src/core/verify/codeFiles'

describe('isCodeLoading (the M68 review)', () => {
  it('names the files the editor’s own tools load and run as code', () => {
    for (const path of [
      'eslint.config.js',
      'eslint.config.mjs',
      'web/vite.config.ts',
      'prettier.config.cjs',
      'karma.conf.js',
      '.eslintrc.cjs',
      '.prettierrc.js',
      '.babelrc.js',
      'gulpfile.js',
      'Gruntfile.cjs',
      '.eslintrc',
      '.eslintrc.json',
      '.prettierrc.yaml',
      '.stylelintrc',
      'package.json',
      'app/package.json',
      '.pnpmfile.cjs',
      'biome.json',
      'deno.jsonc',
      'node_modules/eslint/lib/api.js',
      'packages/a/node_modules/x/index.js',
    ]) {
      expect(isCodeLoading(path), path).toBe(true)
    }
  })

  it('leaves ordinary sources and data alone', () => {
    for (const path of [
      'src/config.ts',
      'src/app.config.json',
      'tsconfig.json',
      'README.md',
      'src/eslint.ts',
      'docs/node_modules.md',
    ]) {
      expect(isCodeLoading(path), path).toBe(false)
    }
  })
})

describe('canChangeWhatRuns (the M68 review)', () => {
  it('holds for files that define commands, code the tools load, and files the command names', () => {
    expect(canChangeWhatRuns('package.json', 'npm run lint')).toBe(true)
    expect(canChangeWhatRuns('Makefile', 'make check')).toBe(true)
    expect(canChangeWhatRuns('pyproject.toml', 'pytest')).toBe(true)
    expect(canChangeWhatRuns('eslint.config.js', 'npx eslint .')).toBe(true)
    expect(canChangeWhatRuns('scripts/check.js', 'node scripts/check.js')).toBe(true)
    expect(canChangeWhatRuns('check.js', 'node ./check.js --fast')).toBe(true)
    expect(canChangeWhatRuns('tools/lint.ps1', String.raw`& '.\tools\lint.ps1'`)).toBe(true)
  })

  it('does not hold for a source file the command does not name', () => {
    expect(canChangeWhatRuns('src/a.ts', 'npm run lint')).toBe(false)
    expect(canChangeWhatRuns('src/check.ts', 'node scripts/lint.js')).toBe(false)
  })
})
