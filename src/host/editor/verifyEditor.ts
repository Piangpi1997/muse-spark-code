// The editor's side of the verify loop (M68, PLAN.md D49), for the Model API
// backend: what VS Code's language servers report on the files an edit tool
// wrote, once they settle, and what the document's formatter makes of a file
// just written (format on edit). The tools write the files on disk; an open
// document is only read here, never edited, so nothing is left unsaved.

import * as vscode from 'vscode'
import { DIAGNOSTIC_SEVERITIES, type DiagnosticEntry } from '../../core/diagnostics'
import type { EditedFile, FileDiagnostics } from '../../core/verify/diagnosticsReport'
import { applyOffsetEdits, type OffsetEdit } from '../../core/verify/textEdits'
import {
  DIAGNOSTICS_SETTLE_FIRST_MS,
  DIAGNOSTICS_SETTLE_MAX_MS,
  DIAGNOSTICS_SETTLE_QUIET_MS,
  EDITOR_DEFAULT_TAB_SIZE,
  FORMAT_SYNC_MAX_MS,
  FORMAT_SYNC_POLL_MS,
  FORMAT_TIMEOUT_MS,
  VSCODE_COMMANDS,
} from '../../shared/constants'
import type { Logger } from '../logger'

/** How long the language servers are given (tests shorten it). */
export interface SettleTiming {
  readonly firstMs: number
  readonly quietMs: number
  readonly maxMs: number
}

const SETTLE_TIMING: SettleTiming = {
  firstMs: DIAGNOSTICS_SETTLE_FIRST_MS,
  quietMs: DIAGNOSTICS_SETTLE_QUIET_MS,
  maxMs: DIAGNOSTICS_SETTLE_MAX_MS,
}

/** How long a document is given to catch up, and the formatter to answer. */
export interface FormatTiming {
  readonly syncMs: number
  readonly pollMs: number
  readonly formatMs: number
}

const FORMAT_TIMING: FormatTiming = {
  syncMs: FORMAT_SYNC_MAX_MS,
  pollMs: FORMAT_SYNC_POLL_MS,
  formatMs: FORMAT_TIMEOUT_MS,
}

export interface VerifyEditorDeps {
  readonly platform: NodeJS.Platform
  readonly log: Logger
  readonly settle?: SettleTiming
  readonly format?: FormatTiming
}

export interface VerifyEditor {
  /** Each file's diagnostics once the servers settle; a stop ends the wait early. */
  diagnosticsAfterEdit(
    files: readonly EditedFile[],
    signal: AbortSignal,
  ): Promise<readonly FileDiagnostics[]>
  /**
   * Shows one file and waits for its server's report, for the diagnostics
   * tool asked about that file: without it the tool reports nothing for a
   * file no editor shows.
   */
  settleFile(absolutePath: string, relative: string): Promise<void>
  /** The file's text as its formatter leaves it, or undefined: no formatter, no change, or not safe. */
  formatAfterEdit(absolutePath: string, text: string): Promise<string | undefined>
}

const BOM = '\u{FEFF}'
const NEVER_STOPPED = new AbortController().signal
const LONE_LINE_FEED = /(?<!\r)\n/g
const CRLF = '\r\n'
const CONFIGURATION_SECTION = 'editor'
const TAB_SIZE = 'tabSize'
const INSERT_SPACES = 'insertSpaces'

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A URI as one key: case-folded where the file system is (Windows). */
function uriKey(uri: vscode.Uri, platform: NodeJS.Platform): string {
  const text = uri.toString()
  return platform === 'win32' ? text.toLowerCase() : text
}

function entryOf(file: EditedFile, diagnostic: vscode.Diagnostic): DiagnosticEntry {
  return {
    path: file.relative,
    severity: DIAGNOSTIC_SEVERITIES[diagnostic.severity] ?? 'error',
    line: diagnostic.range.start.line + 1,
    column: diagnostic.range.start.character + 1,
    message: diagnostic.message,
    source: diagnostic.source,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Resolves once the servers have reported on one of `keys` and then been
 * quiet, when none reported within the first wait, at the cap, on a stop, or
 * at once when the document could not be shown.
 */
async function waitForReports(
  keys: ReadonlySet<string>,
  deps: VerifyEditorDeps,
  signal: AbortSignal,
  showing: Promise<boolean>,
): Promise<void> {
  const timing = deps.settle ?? SETTLE_TIMING
  const settled = Promise.withResolvers<undefined>()
  const finish = () => {
    settled.resolve(undefined)
  }
  let first: ReturnType<typeof setTimeout> | undefined = setTimeout(finish, timing.firstMs)
  let quiet: ReturnType<typeof setTimeout> | undefined
  const cap = setTimeout(finish, timing.maxMs)
  const subscription = vscode.languages.onDidChangeDiagnostics((event) => {
    if (event.uris.every((uri) => !keys.has(uriKey(uri, deps.platform)))) {
      return
    }
    clearTimeout(first)
    first = undefined
    clearTimeout(quiet)
    quiet = setTimeout(finish, timing.quietMs)
  })
  signal.addEventListener('abort', finish, { once: true })
  try {
    if (await showing) {
      await settled.promise
    }
  } finally {
    subscription.dispose()
    clearTimeout(first)
    clearTimeout(quiet)
    clearTimeout(cap)
    signal.removeEventListener('abort', finish)
  }
}

/**
 * Shows the file's document beside the active editor, as a preview and
 * without taking focus, unless an editor already shows it: VS Code's
 * language servers report on a document an editor shows, not on one that is
 * only open (measured for TypeScript and JSON in VS Code 1.139.1, M68).
 * Beside, so nothing typed into the user's own editor lands in it. False,
 * and logged, when the document cannot be opened or shown.
 */
async function canReportOn(
  deps: VerifyEditorDeps,
  uri: vscode.Uri,
  relative: string,
): Promise<boolean> {
  let document: vscode.TextDocument
  try {
    document = await vscode.workspace.openTextDocument(uri)
  } catch (error: unknown) {
    deps.log.warn(`Verify: ${relative} could not be opened for diagnostics: ${describe(error)}`)
    return false
  }
  const key = uriKey(document.uri, deps.platform)
  if (
    vscode.window.visibleTextEditors.some(
      (shown) => uriKey(shown.document.uri, deps.platform) === key,
    )
  ) {
    return true
  }
  try {
    await vscode.window.showTextDocument(document.uri, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
      preserveFocus: true,
    })
  } catch (error: unknown) {
    deps.log.warn(`Verify: ${relative} could not be shown for diagnostics: ${describe(error)}`)
    return false
  }
  return true
}

/**
 * One file's diagnostics once its server settles. Each file is shown and
 * read in turn: a preview replaced by the next file's closes, and the
 * servers drop a closed document's diagnostics.
 */
async function settledDiagnostics(
  deps: VerifyEditorDeps,
  file: EditedFile,
  signal: AbortSignal,
): Promise<FileDiagnostics> {
  const uri = vscode.Uri.file(file.absolute)
  const key = uriKey(uri, deps.platform)
  // Listening starts before the document is shown, so no report is missed.
  await waitForReports(new Set([key]), deps, signal, canReportOn(deps, uri, file.relative))
  const held = vscode.languages
    .getDiagnostics()
    .find(([candidate]) => uriKey(candidate, deps.platform) === key)
  return { file, entries: (held?.[1] ?? []).map((diagnostic) => entryOf(file, diagnostic)) }
}

async function diagnosticsAfterEdit(
  deps: VerifyEditorDeps,
  files: readonly EditedFile[],
  signal: AbortSignal,
): Promise<readonly FileDiagnostics[]> {
  const results: FileDiagnostics[] = []
  for (const file of files) {
    results.push(await settledDiagnostics(deps, file, signal))
  }
  return results
}

/** `work`, or undefined once `ms` pass first. */
async function within<T>(work: Thenable<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined)
    }, ms)
  })
  try {
    return await Promise.race([Promise.resolve(work), late])
  } finally {
    clearTimeout(timer)
  }
}

/** Waits for an open document to hold what the tool wrote; false when it never does. */
async function isCaughtUp(
  document: vscode.TextDocument,
  expected: string,
  timing: FormatTiming,
): Promise<boolean> {
  const deadline = Date.now() + timing.syncMs
  while (document.getText() !== expected) {
    if (document.isDirty || Date.now() >= deadline) {
      return false
    }
    await sleep(timing.pollMs)
  }
  return true
}

function formattingOptions(document: vscode.TextDocument): vscode.FormattingOptions {
  const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION, document)
  return {
    tabSize: configuration.get<number>(TAB_SIZE) ?? EDITOR_DEFAULT_TAB_SIZE,
    insertSpaces: configuration.get<boolean>(INSERT_SPACES) ?? true,
  }
}

async function formatAfterEdit(
  deps: VerifyEditorDeps,
  absolutePath: string,
  text: string,
): Promise<string | undefined> {
  const timing = deps.format ?? FORMAT_TIMING
  const hasBom = text.startsWith(BOM)
  const expected = hasBom ? text.slice(BOM.length) : text
  const uri = vscode.Uri.file(absolutePath)
  const document = await vscode.workspace.openTextDocument(uri)
  if (!(await isCaughtUp(document, expected, timing))) {
    deps.log.info(`Format on edit skipped ${absolutePath}: the editor did not show the new text`)
    return undefined
  }
  const edits = await within(
    vscode.commands.executeCommand<vscode.TextEdit[] | undefined>(
      VSCODE_COMMANDS.formatDocument,
      uri,
      formattingOptions(document),
    ),
    timing.formatMs,
  )
  if (edits === undefined || edits.length === 0 || document.getText() !== expected) {
    return undefined
  }
  const isCrlf = document.eol === vscode.EndOfLine.CRLF
  const offsets: OffsetEdit[] = edits.map((edit) => ({
    start: document.offsetAt(edit.range.start),
    end: document.offsetAt(edit.range.end),
    newText: isCrlf ? edit.newText.replaceAll(LONE_LINE_FEED, () => CRLF) : edit.newText,
  }))
  const formatted = applyOffsetEdits(expected, offsets)
  if (formatted === undefined) {
    deps.log.warn(`Format on edit skipped ${absolutePath}: the formatter's edits overlap`)
    return undefined
  }
  return formatted === expected ? undefined : `${hasBom ? BOM : ''}${formatted}`
}

export function createVerifyEditor(deps: VerifyEditorDeps): VerifyEditor {
  return {
    diagnosticsAfterEdit: (files, signal) => diagnosticsAfterEdit(deps, files, signal),
    // The tool's call has no stop of its own; the cap ends the wait.
    settleFile: async (absolutePath, relative) => {
      await settledDiagnostics(deps, { relative, absolute: absolutePath }, NEVER_STOPPED)
    },
    formatAfterEdit: (absolutePath, text) => formatAfterEdit(deps, absolutePath, text),
  }
}
