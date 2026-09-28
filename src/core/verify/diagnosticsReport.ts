// The edited files' errors and warnings after a round of edits (M68, PLAN.md
// D49): each file's counts, with what changed since the previous check of
// that file, then the entries themselves, worst first and capped. A
// diagnostic is matched across rounds by its severity, source and message,
// never its line, since an edit moves lines. Information and hints are left
// out: they are not what an edit breaks. Pure.

import { MODEL_TEXT, VERIFY_DIAGNOSTICS_MAX_ENTRIES } from '../../shared/constants'
import { fill } from '../../shared/l10n/text'
import { type DiagnosticEntry, formatDiagnostics, type WorkspaceDiagnostic } from '../diagnostics'

/** A file an edit tool wrote this round: as the model named it, and where it is. */
export interface EditedFile {
  /** Workspace-relative, forward slashes. */
  readonly relative: string
  readonly absolute: string
}

/** What the language servers hold for one edited file once they settled. */
export interface FileDiagnostics {
  readonly file: EditedFile
  readonly entries: readonly DiagnosticEntry[]
}

export interface DiagnosticsReport {
  /** For the model and the row's body. */
  readonly text: string
  /** Absent when the diagnostics could not be read. */
  readonly errors?: number
  readonly warnings?: number
}

const KEY_SEPARATOR = '\u{0}'

function isReported(entry: DiagnosticEntry): boolean {
  return entry.severity === 'error' || entry.severity === 'warning'
}

function keyOf(entry: DiagnosticEntry): string {
  return [entry.severity, entry.source ?? '', entry.message].join(KEY_SEPARATOR)
}

function counted(keys: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const key of keys) {
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/** How many entries are new, and how many of the previous ones are gone. */
function changes(
  previous: readonly string[],
  current: readonly string[],
): { readonly added: number; readonly fixed: number } {
  const before = counted(previous)
  const after = counted(current)
  let added = 0
  let fixed = 0
  for (const [key, count] of after) {
    added += Math.max(count - (before.get(key) ?? 0), 0)
  }
  for (const [key, count] of before) {
    fixed += Math.max(count - (after.get(key) ?? 0), 0)
  }
  return { added, fixed }
}

/** The previous round's diagnostics of each file a session edited, to say what changed. */
export class DiagnosticsHistory {
  private readonly previous = new Map<string, readonly string[]>()

  public report(files: readonly FileDiagnostics[]): DiagnosticsReport {
    const lines: string[] = [MODEL_TEXT.verifyDiagnosticsHeading]
    const listed: WorkspaceDiagnostic[] = []
    let errors = 0
    let warnings = 0
    for (const { file, entries } of files) {
      const reported = entries.filter((entry) => isReported(entry))
      const fileErrors = reported.filter((entry) => entry.severity === 'error').length
      errors += fileErrors
      warnings += reported.length - fileErrors
      const keys = reported.map((entry) => keyOf(entry))
      const before = this.previous.get(file.relative)
      this.previous.set(file.relative, keys)
      const summary =
        reported.length === 0
          ? fill(MODEL_TEXT.verifyFileClean, { path: file.relative })
          : fill(MODEL_TEXT.verifyFileCounts, {
              path: file.relative,
              errors: String(fileErrors),
              warnings: String(reported.length - fileErrors),
            })
      const delta = before === undefined ? undefined : changes(before, keys)
      lines.push(
        delta === undefined || (delta.added === 0 && delta.fixed === 0)
          ? summary
          : `${summary} ${fill(MODEL_TEXT.verifyFileChanges, {
              added: String(delta.added),
              fixed: String(delta.fixed),
            })}`,
      )
      listed.push(...reported.map((entry) => ({ ...entry, path: file.relative })))
    }
    if (listed.length > 0) {
      lines.push(formatDiagnostics(listed, VERIFY_DIAGNOSTICS_MAX_ENTRIES))
    }
    return { text: lines.join('\n'), errors, warnings }
  }
}
