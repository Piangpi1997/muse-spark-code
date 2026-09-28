import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkCommandLine,
  checkCommandsSchema,
  checkListText,
  checkTimeoutMs,
  isSafeCheckPath,
  verifyGuidance,
} from '../../src/core/verify/checkCommands'
import {
  CHECK_COMMANDS_MAX,
  CHECK_DEFAULT_TIMEOUT_SECONDS,
  CHECK_MAX_TIMEOUT_SECONDS,
  MILLISECONDS_PER_SECOND,
  MODEL_TEXT,
  WINDOWS_POWERSHELL_RELATIVE_PATH,
} from '../../src/shared/constants'

const LINT = { name: 'lint', command: 'npm run lint', changedFiles: true }
// Names a shell would read as syntax, quotes of both kinds, and spaces.
const TRICKY = ['src/a b.ts', "src/O'Brien’s.ts", 'src/$HOME;x|y&(z).ts']

describe('checkCommandsSchema', () => {
  it('takes the documented shape and trims names and commands', () => {
    const parsed = checkCommandsSchema.parse([
      { name: ' lint ', command: ' npm run lint ', changedFiles: true, timeoutSeconds: 60 },
      { name: 'test', command: 'npm test' },
    ])
    expect(parsed).toEqual([
      { name: 'lint', command: 'npm run lint', changedFiles: true, timeoutSeconds: 60 },
      { name: 'test', command: 'npm test' },
    ])
  })

  it('refuses a blank command, a repeated name, a bad time cap and too many checks', () => {
    expect(checkCommandsSchema.safeParse([{ name: 'lint', command: '  ' }]).success).toBe(false)
    expect(
      checkCommandsSchema.safeParse([
        { name: 'lint', command: 'a' },
        { name: 'lint', command: 'b' },
      ]).success,
    ).toBe(false)
    expect(
      checkCommandsSchema.safeParse([
        { name: 'lint', command: 'a', timeoutSeconds: CHECK_MAX_TIMEOUT_SECONDS + 1 },
      ]).success,
    ).toBe(false)
    expect(
      checkCommandsSchema.safeParse([{ name: 'lint', command: 'a', timeoutSeconds: 0 }]).success,
    ).toBe(false)
    const many = Array.from({ length: CHECK_COMMANDS_MAX + 1 }, (_, index) => ({
      name: `c${String(index)}`,
      command: 'x',
    }))
    expect(checkCommandsSchema.safeParse(many).success).toBe(false)
  })
})

describe('checkCommandLine', () => {
  it('runs an unscoped check, or a scoped one with no files, as the user wrote it', () => {
    expect(checkCommandLine({ name: 'test', command: 'npm test' }, ['a.ts'], 'linux')).toEqual({
      ok: true,
      line: 'npm test',
    })
    expect(checkCommandLine(LINT, [], 'linux')).toEqual({ ok: true, line: 'npm run lint' })
  })

  it('puts each changed file after -- as one quoted argument for the platform shell', () => {
    expect(checkCommandLine(LINT, ['src/a.ts', "b'c.ts"], 'linux')).toEqual({
      ok: true,
      line: String.raw`npm run lint -- 'src/a.ts' 'b'\''c.ts'`,
    })
    expect(checkCommandLine(LINT, ['src/a.ts', "b'c.ts"], 'win32')).toEqual({
      ok: true,
      line: "npm run lint -- 'src/a.ts' 'b''c.ts'",
    })
  })

  it('refuses a path that starts with - or holds a control character, never passing it', () => {
    for (const unsafe of ['-rf', '--help', 'a\nb.ts', 'a\tb.ts', 'a\u{1B}b.ts', '']) {
      expect(isSafeCheckPath(unsafe), JSON.stringify(unsafe)).toBe(false)
      expect(checkCommandLine(LINT, ['ok.ts', unsafe], 'linux')).toEqual({
        ok: false,
        reason: MODEL_TEXT.checkSkipUnsafePath,
      })
    }
    // A dash inside a name is an ordinary file.
    expect(isSafeCheckPath('src/-x.ts')).toBe(true)
  })

  // The quoted paths reach the command as the exact arguments, through the
  // same interpreter the shell tool runs (M27): Windows PowerShell here.
  const systemRoot = process.env['SystemRoot']
  it.skipIf(process.platform !== 'win32' || systemRoot === undefined)(
    'hands PowerShell each path as one argument, whatever it holds',
    () => {
      const powershell = path.win32.join(systemRoot ?? '', WINDOWS_POWERSHELL_RELATIVE_PATH)
      const built = checkCommandLine(
        {
          name: 'argv',
          // `probe` first: node takes a -- right after its script as its own.
          command: `& '${process.execPath}' -e 'console.log(JSON.stringify(process.argv.slice(1)))' probe`,
          changedFiles: true,
        },
        TRICKY,
        'win32',
      )
      if (!built.ok) {
        throw new Error(built.reason)
      }
      const output = execFileSync(
        powershell,
        ['-NoProfile', '-NonInteractive', '-Command', built.line],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )
      expect(JSON.parse(output.trim())).toEqual(['probe', '--', ...TRICKY])
    },
  )

  it.skipIf(process.platform === 'win32')(
    'hands bash each path as one argument, whatever it holds',
    () => {
      const built = checkCommandLine(
        {
          name: 'argv',
          command: `'${process.execPath}' -e 'console.log(JSON.stringify(process.argv.slice(1)))' probe`,
          changedFiles: true,
        },
        TRICKY,
        'linux',
      )
      if (!built.ok) {
        throw new Error(built.reason)
      }
      const output = execFileSync('bash', ['-c', built.line], { encoding: 'utf8' })
      expect(JSON.parse(output.trim())).toEqual(['probe', '--', ...TRICKY])
    },
  )
})

describe('checkTimeoutMs', () => {
  it('is the check’s own cap, else the default', () => {
    expect(checkTimeoutMs({ name: 'a', command: 'b', timeoutSeconds: 12 })).toBe(
      12 * MILLISECONDS_PER_SECOND,
    )
    expect(checkTimeoutMs({ name: 'a', command: 'b' })).toBe(
      CHECK_DEFAULT_TIMEOUT_SECONDS * MILLISECONDS_PER_SECOND,
    )
  })
})

describe('verifyGuidance (Muse Code)', () => {
  it('names the diagnostics tool and the checks inside a harness note', () => {
    const note = verifyGuidance(true, [LINT, { name: 'test', command: 'npm test' }])
    expect(note).toBe(
      `<harness_note>${MODEL_TEXT.verifyGuidanceDiagnostics} The user's check commands are: lint (\`npm run lint\`), test (\`npm test\`). Before you finish, run the ones your change affects.</harness_note>`,
    )
    expect(note).toContain('mcp__ide__getDiagnostics')
  })

  it('says only what is on, and nothing when neither is', () => {
    expect(verifyGuidance(true, [])).toBe(
      `<harness_note>${MODEL_TEXT.verifyGuidanceDiagnostics}</harness_note>`,
    )
    expect(verifyGuidance(false, [LINT])).toBe(
      `<harness_note>The user's check commands are: ${checkListText([LINT])}. Before you finish, run the ones your change affects.</harness_note>`,
    )
    expect(verifyGuidance(false, [])).toBeUndefined()
  })
})
