// The verify loop's record since the user's last input (M68, PLAN.md D49;
// the Codex review of PR #54, third round): one ledger per session in place
// of the counters that were spread over the session and the turn.
//
// It keeps the files the edit tools wrote, each at a version that every edit
// advances, and every check that ran (automatic, `run_checks`, or an edit's
// `then_run` of a configured check's own command) against the versions of
// what it covered. A round's verdict reads only the runs since the previous
// verdict that are still on the latest version of everything they covered;
// the fix loop counts failing verdicts in a row and stops the checks at
// CHECK_FIX_MAX_ROUNDS. `reset` clears it all, and every path that admits
// user input (a message, queued or steered) calls it; a goal's wake is not
// user input and carries on. Pure.

import { CHECK_FIX_MAX_ROUNDS, type CheckOutcome } from '../../../shared/constants'
import { canChangeWhatRuns, isCodeLoading } from '../../verify/codeFiles'
import type { EditedFile } from '../../verify/diagnosticsReport'

/** What a check covered: the whole project, or the files passed to it. */
export type CheckScope = 'project' | readonly EditedFile[]

/** The state a run saw: the project's version, or each covered file's. */
type Coverage =
  | { readonly kind: 'project'; readonly version: number }
  | { readonly kind: 'files'; readonly versions: ReadonlyMap<string, number> }

interface RecordedRun {
  readonly name: string
  /** Only runs that finished: passed, failed or timed out. */
  readonly outcome: CheckOutcome
  readonly coverage: Coverage
}

/** Outcomes that say something about the code: not run, or stopped by the user, say nothing. */
function isJudged(outcome: CheckOutcome): boolean {
  return outcome !== 'notRun' && outcome !== 'cancelled'
}

export class VerifyLedger {
  private failedRounds = 0
  private stopped = false
  private readonly rejectedChecks = new Set<string>()
  /** The files written since the user's input, by real path, at their latest version. */
  private readonly files = new Map<
    string,
    { readonly file: EditedFile; readonly version: number }
  >()
  private readonly writtenNames = new Set<string>()
  private firstCodeFile: string | undefined
  /** Advanced by every edit; a file's version is the project's at its last edit. */
  private projectVersion = 0
  private readonly roundFiles = new Map<string, EditedFile>()
  private runs: RecordedRun[] = []
  /** Where the runs not yet judged start. */
  private judgedUpTo = 0

  private versionOf(absolute: string): number {
    return this.files.get(absolute)?.version ?? 0
  }

  private isCurrent(run: RecordedRun): boolean {
    const { coverage } = run
    return coverage.kind === 'project'
      ? coverage.version === this.projectVersion
      : [...coverage.versions].every(([absolute, version]) => this.versionOf(absolute) === version)
  }

  /** Any admitted user input, queued or steered: the loop starts afresh. */
  public reset(): void {
    this.failedRounds = 0
    this.stopped = false
    this.rejectedChecks.clear()
    this.files.clear()
    this.writtenNames.clear()
    this.firstCodeFile = undefined
    this.roundFiles.clear()
    this.runs = []
    this.judgedUpTo = 0
  }

  /** A new turn: what a stopped turn left for its round is neither checked nor judged. */
  public beginTurn(): void {
    this.roundFiles.clear()
    this.judgedUpTo = this.runs.length
  }

  /**
   * A file an edit tool wrote, with the names it was written under (as given
   * and after links): a new version of it and of the project.
   */
  public noteEdit(file: EditedFile, names: readonly string[]): void {
    this.projectVersion += 1
    this.files.set(file.absolute, { file, version: this.projectVersion })
    this.roundFiles.set(file.absolute, file)
    for (const name of names) {
      this.writtenNames.add(name)
    }
    if (this.firstCodeFile === undefined && names.some((name) => isCodeLoading(name))) {
      this.firstCodeFile = file.relative
    }
  }

  /** The first file written that the editor's tools run as code, if any. */
  public get codeFile(): string | undefined {
    return this.firstCodeFile
  }

  /** Whether the fix loop stopped the checks. */
  public get isStopped(): boolean {
    return this.stopped
  }

  public isRejected(name: string): boolean {
    return this.rejectedChecks.has(name)
  }

  public reject(name: string): void {
    this.rejectedChecks.add(name)
  }

  /** Whether a file written since the user's input decides what `command` runs. */
  public changesWhatRuns(command: string): boolean {
    return [...this.writtenNames].some((name) => canChangeWhatRuns(name, command))
  }

  /** The files written since the user's input: `run_checks`'s default. */
  public editedFiles(): readonly EditedFile[] {
    return Array.from(this.files.values(), ({ file }) => file)
  }

  /** The files written in the round that just ended, taken for its checks. */
  public takeRoundEdits(): readonly EditedFile[] {
    const edited = Array.from(this.roundFiles, ([, file]) => file)
    this.roundFiles.clear()
    return edited
  }

  /** A check that ran over `scope`, recorded against the state it saw. */
  public record(name: string, outcome: CheckOutcome, scope: CheckScope): void {
    if (!isJudged(outcome)) {
      return
    }
    const coverage: Coverage =
      scope === 'project'
        ? { kind: 'project', version: this.projectVersion }
        : {
            kind: 'files',
            versions: new Map(scope.map((file) => [file.absolute, this.versionOf(file.absolute)])),
          }
    this.runs.push({ name, outcome, coverage })
  }

  /** Whether `name` already ran on the latest state of everything `scope` holds. */
  public hasCurrentRun(name: string, scope: CheckScope): boolean {
    return this.runs.some(
      (run) => run.name === name && this.isCurrent(run) && isCovering(run.coverage, scope),
    )
  }

  /**
   * The verdict on the runs since the previous one, read only from those
   * still on the latest state of what they covered: failed when one of them
   * failed or timed out, passed when all passed, nothing when none. The fix
   * loop advances on a failed verdict and resets on a passed one; true when
   * this verdict stopped the checks.
   */
  public judgeRound(): boolean {
    const judged = this.runs.slice(this.judgedUpTo).filter((run) => this.isCurrent(run))
    this.judgedUpTo = this.runs.length
    if (judged.length === 0) {
      return false
    }
    if (judged.every((run) => run.outcome === 'passed')) {
      this.failedRounds = 0
      return false
    }
    if (this.stopped) {
      return false
    }
    this.failedRounds += 1
    if (this.failedRounds < CHECK_FIX_MAX_ROUNDS) {
      return false
    }
    this.stopped = true
    return true
  }
}

/** Whether a run over `coverage` answers for `scope`: the whole project answers for any. */
function isCovering(coverage: Coverage, scope: CheckScope): boolean {
  return (
    coverage.kind === 'project' ||
    (scope !== 'project' && scope.every((file) => coverage.versions.has(file.absolute)))
  )
}
