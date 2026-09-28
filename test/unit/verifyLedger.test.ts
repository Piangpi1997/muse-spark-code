// The verify loop's ledger (M68; the Codex review of PR #54, third round):
// runs recorded against the state they saw, a round's verdict from the runs
// still on the latest state, the fix loop's count, and one reset.

import { describe, expect, it } from 'vitest'
import { VerifyLedger } from '../../src/core/backends/modelapi/verifyLedger'
import { CHECK_FIX_MAX_ROUNDS } from '../../src/shared/constants'

const A = { relative: 'src/a.ts', absolute: '/ws/src/a.ts' }
const B = { relative: 'src/b.ts', absolute: '/ws/src/b.ts' }

/** `rounds` failing verdicts in a row; whether the last one stopped the checks. */
function hasStoppedAfter(ledger: VerifyLedger, rounds: number): boolean {
  let isStopping = false
  for (let round = 0; round < rounds; round += 1) {
    ledger.record('lint', 'failed', 'project')
    isStopping = ledger.judgeRound()
  }
  return isStopping
}

describe('VerifyLedger', () => {
  it('judges a round only by the runs on the latest state of what they covered', () => {
    const ledger = new VerifyLedger()
    // A failing whole-project run, then an edit, then a passing run: passed.
    ledger.record('lint', 'failed', 'project')
    ledger.noteEdit(A, [A.relative])
    ledger.record('lint', 'passed', [A])
    expect(ledger.judgeRound()).toBe(false)
    expect(hasStoppedAfter(ledger, CHECK_FIX_MAX_ROUNDS - 1)).toBe(false)
    expect(ledger.isStopped).toBe(false)
  })

  it('keeps a run on files an edit did not touch, and drops one on a file it did', () => {
    const ledger = new VerifyLedger()
    ledger.noteEdit(A, [A.relative])
    ledger.noteEdit(B, [B.relative])
    ledger.record('lint', 'passed', [A])
    ledger.record('types', 'passed', [B])
    ledger.noteEdit(B, [B.relative])
    expect(ledger.hasCurrentRun('lint', [A])).toBe(true)
    expect(ledger.hasCurrentRun('types', [B])).toBe(false)
    // A run over one file does not answer for another, nor for the project.
    expect(ledger.hasCurrentRun('lint', [A, B])).toBe(false)
    expect(ledger.hasCurrentRun('lint', 'project')).toBe(false)
    // A whole-project run answers for any scope until the next edit.
    ledger.record('test', 'passed', 'project')
    expect(ledger.hasCurrentRun('test', [A, B])).toBe(true)
    ledger.noteEdit(A, [A.relative])
    expect(ledger.hasCurrentRun('test', [B])).toBe(false)
  })

  it('counts failing verdicts in a row, resets on a passing one, and stops at the limit', () => {
    const ledger = new VerifyLedger()
    expect(hasStoppedAfter(ledger, CHECK_FIX_MAX_ROUNDS - 1)).toBe(false)
    ledger.record('lint', 'passed', 'project')
    expect(ledger.judgeRound()).toBe(false)
    expect(hasStoppedAfter(ledger, CHECK_FIX_MAX_ROUNDS - 1)).toBe(false)
    expect(hasStoppedAfter(ledger, 1)).toBe(true)
    expect(ledger.isStopped).toBe(true)
    // Once stopped, a further failing verdict does not announce it again.
    expect(hasStoppedAfter(ledger, 1)).toBe(false)
  })

  it('judges each run once, and leaves the count alone when nothing ran', () => {
    const ledger = new VerifyLedger()
    ledger.record('lint', 'failed', 'project')
    ledger.record('lint', 'notRun', 'project')
    ledger.record('lint', 'cancelled', 'project')
    expect(ledger.judgeRound()).toBe(false)
    // Nothing new ran: the next rounds judge nothing, twice.
    expect(ledger.judgeRound()).toBe(false)
    expect(ledger.judgeRound()).toBe(false)
    expect(hasStoppedAfter(ledger, CHECK_FIX_MAX_ROUNDS - 1)).toBe(true)
  })

  it('records nothing for a check that did not run or was stopped', () => {
    const ledger = new VerifyLedger()
    ledger.record('lint', 'notRun', 'project')
    ledger.record('test', 'cancelled', 'project')
    // Neither answers for the check, nor moves the fix loop.
    expect(ledger.hasCurrentRun('lint', 'project')).toBe(false)
    expect(ledger.hasCurrentRun('test', 'project')).toBe(false)
    expect(ledger.judgeRound()).toBe(false)
    expect(hasStoppedAfter(ledger, CHECK_FIX_MAX_ROUNDS - 1)).toBe(false)
    expect(hasStoppedAfter(ledger, 1)).toBe(true)
  })

  it('forgets everything on the user’s input, and a stopped turn’s round on a new turn', () => {
    const ledger = new VerifyLedger()
    ledger.noteEdit(A, [A.relative, 'package.json'])
    ledger.reject('lint')
    hasStoppedAfter(ledger, CHECK_FIX_MAX_ROUNDS)
    expect(ledger.changesWhatRuns('npm run lint')).toBe(true)
    ledger.reset()
    expect(ledger.isStopped).toBe(false)
    expect(ledger.isRejected('lint')).toBe(false)
    expect(ledger.editedFiles()).toEqual([])
    expect(ledger.takeRoundEdits()).toEqual([])
    expect(ledger.changesWhatRuns('npm run lint')).toBe(false)
    expect(ledger.codeFile).toBeUndefined()
    // A new turn drops the round a stopped turn left, and its unjudged runs.
    ledger.noteEdit(B, [B.relative])
    ledger.record('lint', 'failed', 'project')
    ledger.beginTurn()
    expect(ledger.takeRoundEdits()).toEqual([])
    expect(ledger.editedFiles()).toEqual([B])
    expect(hasStoppedAfter(ledger, CHECK_FIX_MAX_ROUNDS - 1)).toBe(false)
  })

  it('names the first file written that the editor’s tools run as code', () => {
    const ledger = new VerifyLedger()
    ledger.noteEdit(A, [A.relative])
    expect(ledger.codeFile).toBeUndefined()
    const config = { relative: 'eslint.config.js', absolute: '/ws/eslint.config.js' }
    ledger.noteEdit(config, [config.relative])
    ledger.noteEdit({ relative: 'package.json', absolute: '/ws/package.json' }, ['package.json'])
    expect(ledger.codeFile).toBe('eslint.config.js')
    expect(ledger.takeRoundEdits().map((file) => file.relative)).toEqual([
      'src/a.ts',
      'eslint.config.js',
      'package.json',
    ])
  })
})
