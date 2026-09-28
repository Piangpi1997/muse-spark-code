import { describe, expect, it } from 'vitest'
import type { DiagnosticEntry } from '../../src/core/diagnostics'
import { DiagnosticsHistory, type EditedFile } from '../../src/core/verify/diagnosticsReport'
import { applyOffsetEdits } from '../../src/core/verify/textEdits'
import { MODEL_TEXT, VERIFY_DIAGNOSTICS_MAX_ENTRIES } from '../../src/shared/constants'

const A: EditedFile = { relative: 'src/a.ts', absolute: '/ws/src/a.ts' }
const B: EditedFile = { relative: 'src/b.ts', absolute: '/ws/src/b.ts' }

function entry(
  severity: DiagnosticEntry['severity'],
  message: string,
  line = 1,
  source: string | undefined = 'ts',
): DiagnosticEntry {
  return { path: undefined, severity, line, column: 1, message, source }
}

describe('DiagnosticsHistory', () => {
  it("counts each file's errors and warnings and lists them, leaving hints out", () => {
    const report = new DiagnosticsHistory().report([
      {
        file: A,
        entries: [
          entry('error', 'bad', 3),
          entry('warning', 'unused', 1, 'eslint'),
          entry('hint', 'meh'),
          entry('information', 'fyi'),
        ],
      },
      { file: B, entries: [] },
    ])
    expect(report).toEqual({
      text: [
        MODEL_TEXT.verifyDiagnosticsHeading,
        'src/a.ts: errors 1, warnings 1',
        'src/b.ts: no errors or warnings',
        'src/a.ts:3:1: error: bad [ts]\nsrc/a.ts:1:1: warning: unused [eslint]',
      ].join('\n'),
      errors: 1,
      warnings: 1,
    })
  })

  it('says what changed since the previous check, matching by message, not line', () => {
    const history = new DiagnosticsHistory()
    history.report([{ file: A, entries: [entry('error', 'bad', 3), entry('error', 'worse', 9)] }])
    // `bad` moved down a line and stays; `worse` is fixed; `new` is new.
    const second = history.report([
      { file: A, entries: [entry('error', 'bad', 4), entry('warning', 'new', 1)] },
    ])
    expect(second.text.split('\n', 2)[1]).toBe(
      'src/a.ts: errors 1, warnings 1 (1 new, 1 fixed since the previous check)',
    )
    // Unchanged since then: no note.
    const third = history.report([
      { file: A, entries: [entry('error', 'bad', 4), entry('warning', 'new', 1)] },
    ])
    expect(third.text.split('\n', 2)[1]).toBe('src/a.ts: errors 1, warnings 1')
    // All fixed: clean, with the count of what went.
    const fourth = history.report([{ file: A, entries: [] }])
    expect(fourth.text).toBe(
      `${MODEL_TEXT.verifyDiagnosticsHeading}\nsrc/a.ts: no errors or warnings (0 new, 2 fixed since the previous check)`,
    )
  })

  it('caps the listed entries with a count', () => {
    const flood = Array.from({ length: VERIFY_DIAGNOSTICS_MAX_ENTRIES + 3 }, (_, index) =>
      entry('error', `e${String(index)}`, index + 1),
    )
    const report = new DiagnosticsHistory().report([{ file: A, entries: flood }])
    expect(report.errors).toBe(VERIFY_DIAGNOSTICS_MAX_ENTRIES + 3)
    expect(report.text.endsWith('… 3 more not shown')).toBe(true)
  })
})

describe('applyOffsetEdits', () => {
  it('applies non-overlapping edits wherever they are listed', () => {
    expect(
      applyOffsetEdits('let  a=1', [
        { start: 6, end: 7, newText: ' = ' },
        { start: 3, end: 5, newText: ' ' },
      ]),
    ).toBe('let a = 1')
  })

  it('keeps insertions at one offset in their order', () => {
    expect(
      applyOffsetEdits('ab', [
        { start: 1, end: 1, newText: 'x' },
        { start: 1, end: 1, newText: 'y' },
      ]),
    ).toBe('axyb')
  })

  it('refuses edits that overlap or fall outside the text', () => {
    expect(
      applyOffsetEdits('abcdef', [
        { start: 1, end: 4, newText: '' },
        { start: 3, end: 5, newText: '' },
      ]),
    ).toBeUndefined()
    expect(applyOffsetEdits('abc', [{ start: 2, end: 9, newText: '' }])).toBeUndefined()
    expect(applyOffsetEdits('abc', [{ start: -1, end: 1, newText: '' }])).toBeUndefined()
    expect(applyOffsetEdits('abc', [{ start: 2, end: 1, newText: '' }])).toBeUndefined()
  })
})
