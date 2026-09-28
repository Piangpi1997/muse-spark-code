// The code intelligence tools on the Model API backend (M67, PLAN.md D49):
// the read tools' answers as tool outcomes, and `rename_symbol` written
// through the edit path. A rename's plan (src/core/codeIntel/rename.ts) is
// made before its card; once approved, every file is confined, checked for
// unsaved changes and read again, and nothing is written unless each is
// still exactly as planned. The files are then written one by one with the
// tools' atomic write, and the row carries one patch across them, so Edit
// Review and rewind cover the rename as they cover `edit_file`.

import { MODEL_TEXT, RENAME_CARD_FILES_SHOWN, UI_TEXT } from '../../../shared/constants'
import { fill, plural } from '../../../shared/l10n/text'
import { ADD_MARKER, type PatchFile, REMOVE_MARKER } from '../../../shared/patchDocument'
import type { CodeIntelDeps } from '../../codeIntel/codeIntelQuery'
import { answerCodeIntel, type CodeIntelReadTool } from '../../codeIntel/codeIntelTools'
import {
  planRename,
  type RenameFile,
  type RenamePlan,
  type RenamePlanResult,
} from '../../codeIntel/rename'
import { confineWorkspacePath } from '../../workspacePath'
import { fingerprint, type ToolIo, type ToolOutcome } from './tools'

const NOT_JSON = 'arguments are not valid JSON'

function failed(reason: string, visibleReason: string = reason): ToolOutcome {
  return { output: `Error: ${reason}`, visibleOutput: visibleReason, failureReason: visibleReason }
}

/** The model's arguments as a value; undefined when they are not JSON. */
function parsedArguments(argsJson: string): { readonly value: unknown } | undefined {
  try {
    return { value: JSON.parse(argsJson) }
  } catch {
    return undefined
  }
}

/** A read tool's answer as the model and the row get it. */
export async function runCodeIntelRead(
  tool: CodeIntelReadTool,
  argsJson: string,
  deps: CodeIntelDeps,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  const args = parsedArguments(argsJson)
  if (args === undefined) {
    return failed(NOT_JSON)
  }
  const answer = await answerCodeIntel(tool, args.value, deps, signal)
  return answer.ok
    ? { output: answer.text, visibleOutput: answer.text }
    : failed(answer.reason, answer.visibleReason)
}

/** A rename call's plan, made before its card: nothing is written here. */
export async function planRenameCall(
  argsJson: string,
  deps: CodeIntelDeps,
): Promise<RenamePlanResult> {
  const args = parsedArguments(argsJson)
  return args === undefined
    ? { ok: false, reason: NOT_JSON, visibleReason: NOT_JSON }
    : await planRename(args.value, deps)
}

/** The outcome of a rename that could not be planned. */
export function renameRefused(result: Extract<RenamePlanResult, { ok: false }>): ToolOutcome {
  return failed(result.reason, result.visibleReason)
}

/** What the rename's card names: a few of the files, and how many more. */
export function renameCardPath(plan: RenamePlan): string {
  const shown = plan.files.slice(0, RENAME_CARD_FILES_SHOWN).map((file) => file.relative)
  const hidden = plan.files.length - shown.length
  const files = shown.join(', ')
  return hidden > 0 ? plural(UI_TEXT.renameCardMore, hidden, { files }) : files
}

export interface RenameWriteContext {
  readonly workspaceRoot: string
  readonly platform: NodeJS.Platform
  readonly io: ToolIo
  /** The session's fingerprints of what the model last read or wrote (D27). */
  readonly seen: Map<string, string>
}

/**
 * The file with the key its fingerprint is kept under (the path the file
 * tools resolve), or the refusal when it no longer leads where the plan
 * found it, has unsaved changes, or changed on disk.
 */
async function recheck(
  file: RenameFile,
  context: RenameWriteContext,
): Promise<ToolOutcome | { readonly file: RenameFile; readonly key: string }> {
  const { io } = context
  const resolved = await confineWorkspacePath(
    context.workspaceRoot,
    file.relative,
    context.platform,
    io,
  )
  if (!resolved.ok || resolved.checkedAbsolute !== file.checkedAbsolute) {
    return failed(MODEL_TEXT.pathChangedAfterApproval)
  }
  if (io.hasUnsavedChanges(file.absolute) || io.hasUnsavedChanges(file.checkedAbsolute)) {
    return failed(`${file.relative} ${MODEL_TEXT.fileHasUnsavedChanges}`)
  }
  const current = await io.readFile(file.checkedAbsolute, file.checkedAbsolute)
  return current === file.before
    ? { file, key: resolved.absolute }
    : failed(fill(MODEL_TEXT.renameChanged, { path: file.relative }))
}

/** The patch across the files written, for the row, Edit Review and rewind. */
function renamePatch(files: readonly RenameFile[]): NonNullable<ToolOutcome['patch']> {
  const patchFiles: PatchFile[] = files.map((file) => ({
    path: file.relative,
    hunks: [...file.hunks],
    created: false,
  }))
  const lines = files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines))
  return {
    document: JSON.stringify({ files: patchFiles }),
    summary: {
      files: files.length,
      added: lines.filter((line) => line.startsWith(ADD_MARKER)).length,
      removed: lines.filter((line) => line.startsWith(REMOVE_MARKER)).length,
    },
  }
}

/**
 * Writes an approved rename: every file checked again first (nothing is
 * written if one moved, changed or gained unsaved changes while the card
 * was open), then each written in turn. A write that fails stops the rest
 * and says which files were written, and the row can revert them.
 */
export async function applyRename(
  plan: RenamePlan,
  context: RenameWriteContext,
): Promise<ToolOutcome> {
  const checked: { readonly file: RenameFile; readonly key: string }[] = []
  for (const file of plan.files) {
    const result = await recheck(file, context)
    if (!('key' in result)) {
      return result
    }
    checked.push(result)
  }
  const written: RenameFile[] = []
  for (const { file, key } of checked) {
    try {
      await context.io.writeFile(file.checkedAbsolute, file.after, file.checkedAbsolute)
    } catch (error: unknown) {
      const reason = fill(MODEL_TEXT.renamePartial, {
        path: file.relative,
        reason: error instanceof Error ? error.message : String(error),
        written: String(written.length),
        total: String(plan.files.length),
        paths: written.map((done) => done.relative).join(', '),
      })
      return { ...failed(reason), ...(written.length > 0 && { patch: renamePatch(written) }) }
    }
    written.push(file)
    context.seen.set(key, fingerprint(file.after))
  }
  const output = fill(MODEL_TEXT.renameDone, {
    from: plan.from,
    to: plan.to,
    edits: String(plan.edits),
    files: String(plan.files.length),
    paths: plan.files.map((file) => file.relative).join(', '),
  })
  return { output, visibleOutput: output, patch: renamePatch(written) }
}
