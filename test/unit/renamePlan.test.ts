// `rename_symbol`'s plan (M67, PLAN.md D49): the language service's edit
// checked before anything asks or writes (every file in the workspace,
// saved, and on disk as VS Code holds it), and the diff the `ide` tool
// hands Muse Code.

import { describe, expect, it } from 'vitest'
import type { CodeIntelDeps } from '../../src/core/codeIntel/codeIntelQuery'
import type { FileEdits, RenameEdits } from '../../src/core/codeIntel/languageService'
import { planRename, renameDiff } from '../../src/core/codeIntel/rename'
import { RENAME_MAX_FILES } from '../../src/shared/constants'
import {
  type FakeServiceOptions,
  fakeLanguageService,
  KIND,
  sym,
} from './helpers/fakeLanguageService'
import { memoryToolIo } from './helpers/fakeToolIo'

const ROOT = '/ws'
const A = `${ROOT}/src/a.ts`
const B = `${ROOT}/src/b.ts`
const BOM = '\u{FEFF}'
const FILES = {
  'src/a.ts': `${BOM}export function greet() {}\r\n`,
  'src/b.ts': "import { greet } from './a'\ngreet()\n",
}
const ARGS = { path: 'src/a.ts', line: 1, column: 17, new_name: 'welcome' }

function renameIn(path: string | undefined, line: number, character: number): FileEdits {
  return {
    path,
    edits: [
      {
        range: { start: { line, character }, end: { line, character: character + 5 } },
        newText: 'welcome',
      },
    ],
  }
}

const EDITS: RenameEdits = {
  files: [renameIn(B, 0, 9), renameIn(A, 0, 16), { path: B, edits: [renameIn(B, 1, 0).edits[0]!] }],
  hasFileOperations: false,
}

function setup(options: Omit<FakeServiceOptions, 'files'> = {}) {
  const io = memoryToolIo(FILES, ROOT)
  const service = fakeLanguageService({
    files: io.files,
    rename: () => Promise.resolve(EDITS),
    ...options,
  })
  const deps: CodeIntelDeps = { service, workspaceRoot: ROOT, platform: 'linux', io, now: () => 0 }
  return { io, service, plan: async (args: unknown) => await planRename(args, deps) }
}

async function reasonOf(result: ReturnType<ReturnType<typeof setup>['plan']>): Promise<string> {
  const settled = await result
  if (settled.ok) {
    throw new Error('the rename was planned')
  }
  return settled.reason
}

describe('planRename', () => {
  it("plans every file's text, keeping its BOM and line breaks, and writes nothing", async () => {
    const t = setup()
    const result = await t.plan(ARGS)
    if (!result.ok) {
      throw new Error(result.reason)
    }
    const { plan } = result
    expect(plan).toMatchObject({ from: 'greet', to: 'welcome', edits: 3 })
    expect(plan.files.map((file) => [file.relative, file.after])).toEqual([
      ['src/a.ts', `${BOM}export function welcome() {}\r\n`],
      ['src/b.ts', "import { welcome } from './a'\nwelcome()\n"],
    ])
    expect(t.io.files.get(A)).toBe(FILES['src/a.ts'])
    expect(renameDiff(plan)).toBe(
      [
        'The rename of `greet` to `welcome`: 3 edits in 2 files. This tool changed nothing: apply the diff below with your own edit tool.',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,1 +1,1 @@',
        '-export function greet() {}',
        '+export function welcome() {}',
        '--- a/src/b.ts',
        '+++ b/src/b.ts',
        '@@ -1,2 +1,2 @@',
        "-import { greet } from './a'",
        '-greet()',
        "+import { welcome } from './a'",
        '+welcome()',
      ].join('\n'),
    )
  })

  it('refuses a rename it cannot do whole, before anything asks', async () => {
    const outside = setup({
      rename: () =>
        Promise.resolve({
          ...EDITS,
          files: [...EDITS.files, renameIn('/lib/x.d.ts', 0, 0), renameIn(undefined, 0, 0)],
        }),
    })
    const moves = setup({ rename: () => Promise.resolve({ ...EDITS, hasFileOperations: true }) })
    const many = setup({
      rename: () =>
        Promise.resolve({
          files: Array.from({ length: RENAME_MAX_FILES + 1 }, (_, index) =>
            renameIn(`${ROOT}/f${String(index)}.ts`, 0, 0),
          ),
          hasFileOperations: false,
        }),
    })
    const unsaved = setup()
    unsaved.io.unsaved.add(B)
    const stale = setup({ buffers: { [B]: 'an older text\n' } })
    const dirty = setup({ dirty: new Set([B]) })
    const broken = setup({
      rename: () => Promise.resolve({ files: [renameIn(B, 9, 0)], hasFileOperations: false }),
    })
    expect(await reasonOf(outside.plan(ARGS))).toBe(
      'this rename would also change 2 files outside the workspace; nothing was changed',
    )
    expect(await reasonOf(moves.plan(ARGS))).toContain('would also create, move or delete files')
    expect(await reasonOf(many.plan(ARGS))).toBe(
      `this rename would change ${String(RENAME_MAX_FILES + 1)} files, more than ${String(RENAME_MAX_FILES)}; nothing was changed`,
    )
    expect(await reasonOf(unsaved.plan(ARGS))).toContain('src/b.ts has unsaved changes')
    expect(await reasonOf(stale.plan(ARGS))).toContain(
      'src/b.ts differs between VS Code and the disk',
    )
    expect(await reasonOf(dirty.plan(ARGS))).toContain(
      'src/b.ts differs between VS Code and the disk',
    )
    expect(await reasonOf(broken.plan(ARGS))).toContain(
      'src/b.ts differs between VS Code and the disk',
    )
    expect(await reasonOf(setup().plan({ ...ARGS, new_name: '' }))).toContain('new_name must be')
    expect(await reasonOf(setup().plan('not an object'))).toContain('invalid arguments')
  })

  it('says whether nothing can be renamed there, or no language service answers', async () => {
    const none = { rename: () => Promise.resolve({ files: [], hasFileOperations: false }) }
    const withSymbols = setup({
      ...none,
      symbols: { [A]: [sym('greet', KIND.function, A, 0, 16)] },
    })
    expect(await reasonOf(withSymbols.plan(ARGS))).toBe('nothing to rename at src/a.ts:1:17')
    expect(await reasonOf(setup(none).plan(ARGS))).toContain(
      'no language service answered for src/a.ts',
    )
    const same = setup({
      rename: () =>
        Promise.resolve({
          files: [{ path: A, edits: [{ ...renameIn(A, 0, 16).edits[0]!, newText: 'greet' }] }],
          hasFileOperations: false,
        }),
    })
    expect(await reasonOf(same.plan({ ...ARGS, new_name: 'greet' }))).toBe(
      'nothing to rename at src/a.ts:1:17',
    )
  })

  it("passes the provider's refusal on", async () => {
    const t = setup({ rename: () => Promise.reject(new Error('You cannot rename this element.')) })
    await expect(t.plan(ARGS)).rejects.toThrow('You cannot rename this element.')
  })
})
