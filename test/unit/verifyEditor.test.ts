// The editor's side of the verify loop (M68): the language servers' reports
// on edited files once they settle, and format on edit, over the `vscode`
// mock. The real API is exercised by the integration test inside VS Code.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'
import {
  commands,
  diagnosticsChanged,
  EndOfLine,
  languages,
  Uri,
  ViewColumn,
  window,
  workspace,
} from './mocks/vscode'
import { createVerifyEditor, type VerifyEditor } from '../../src/host/editor/verifyEditor'
import { FakeLogOutputChannel } from './helpers/fakes'
import { logLines } from './helpers/logText'
import { createLogger } from '../../src/host/logger'

const shownDocument = window.showTextDocument

const FILE = { relative: 'src/a.ts', absolute: '/ws/src/a.ts' }
const OTHER = { relative: 'src/b.ts', absolute: '/ws/src/b.ts' }
const SETTLE = { firstMs: 60, quietMs: 25, maxMs: 400 }
const FORMAT = { syncMs: 60, pollMs: 5, formatMs: 60 }
const EDITOR_SETTINGS: Readonly<Record<string, unknown>> = { tabSize: 2, insertSpaces: true }

interface DocumentState {
  text: string
  isDirty?: boolean
  eol?: (typeof EndOfLine)[keyof typeof EndOfLine]
}

/** The offset of a position in `text`, counting each line break's characters. */
function offsetOf(text: string, position: { line: number; character: number }): number {
  let offset = 0
  for (let line = 0; line < position.line; line += 1) {
    offset = text.indexOf('\n', offset) + 1
  }
  return offset + position.character
}

function fakeDocument(
  state: DocumentState,
  uri: vscode.Uri = Uri.file('/doc'),
): vscode.TextDocument {
  const document = {
    uri,
    get isDirty() {
      return state.isDirty ?? false
    },
    get eol() {
      return state.eol ?? EndOfLine.LF
    },
    getText: () => state.text,
    offsetAt: (position: vscode.Position) => offsetOf(state.text, position),
  }
  // Only what the verify editor reads of a document; nothing else is touched.
  return document as unknown as vscode.TextDocument
}

function fakeEditor(uri: vscode.Uri): vscode.TextEditor {
  // An editor showing a document: all the verify editor reads of one.
  return { document: { uri } } as unknown as vscode.TextEditor
}

function diagnostic(
  severity: number,
  line: number,
  character: number,
  message: string,
): vscode.Diagnostic {
  // The fields the verify editor maps; a real Diagnostic has these and more.
  return {
    severity,
    range: { start: { line, character } },
    message,
    source: 'ts',
  } as unknown as vscode.Diagnostic
}

function textEdit(
  start: [number, number],
  end: [number, number],
  newText: string,
): vscode.TextEdit {
  // A formatter's edit as the command returns it: a range and the new text.
  return {
    range: {
      start: { line: start[0], character: start[1] },
      end: { line: end[0], character: end[1] },
    },
    newText,
  } as unknown as vscode.TextEdit
}

function editor(platform: NodeJS.Platform = 'linux'): {
  verify: VerifyEditor
  channel: FakeLogOutputChannel
} {
  const channel = new FakeLogOutputChannel()
  return {
    verify: createVerifyEditor({
      platform,
      log: createLogger(channel),
      settle: SETTLE,
      format: FORMAT,
    }),
    channel,
  }
}

function report(...paths: readonly string[]): void {
  diagnosticsChanged.fire({ uris: paths.map((path) => Uri.file(path)) })
}

beforeEach(() => {
  vi.mocked(workspace.openTextDocument).mockImplementation((uri) =>
    Promise.resolve(fakeDocument({ text: uri.fsPath }, uri)),
  )
  // The one method the verify editor reads of a configuration.
  vi.mocked(workspace.getConfiguration).mockReturnValue({
    get: (key: string) => EDITOR_SETTINGS[key],
  } as unknown as vscode.WorkspaceConfiguration)
  vi.mocked(languages.getDiagnostics).mockReturnValue([])
  vi.mocked(shownDocument).mockResolvedValue(fakeEditor(Uri.file('/shown')))
  window.visibleTextEditors = []
})

afterEach(() => {
  vi.mocked(workspace.openTextDocument).mockReset()
  vi.mocked(commands.executeCommand).mockReset()
  vi.mocked(languages.getDiagnostics).mockReset()
  vi.mocked(shownDocument).mockReset()
})

describe('diagnosticsAfterEdit', () => {
  it('shows each file beside, waits for its report to settle, and maps what the servers hold', async () => {
    const { verify } = editor()
    vi.mocked(languages.getDiagnostics).mockReturnValue([
      [Uri.file(FILE.absolute), [diagnostic(0, 2, 4, 'bad'), diagnostic(1, 0, 0, 'unused')]],
      [Uri.file('/ws/elsewhere.ts'), [diagnostic(0, 0, 0, 'not ours')]],
    ])
    const started = Date.now()
    const pending = verify.diagnosticsAfterEdit([FILE, OTHER], new AbortController().signal)
    setTimeout(() => {
      report(FILE.absolute)
    }, 10)
    const files = await pending
    // The first file settles on its report; the second waits out its first wait.
    expect(Date.now() - started).toBeLessThan(SETTLE.firstMs * 2 + SETTLE.quietMs)
    expect(vi.mocked(workspace.openTextDocument).mock.calls.map(([uri]) => uri.fsPath)).toEqual([
      FILE.absolute,
      OTHER.absolute,
    ])
    // Each shown beside the user's editor, as a preview, without taking focus.
    expect(
      vi.mocked(shownDocument).mock.calls.map(([uri, options]) => [uri.fsPath, options]),
    ).toEqual([
      [FILE.absolute, { viewColumn: ViewColumn.Beside, preview: true, preserveFocus: true }],
      [OTHER.absolute, { viewColumn: ViewColumn.Beside, preview: true, preserveFocus: true }],
    ])
    expect(files).toEqual([
      {
        file: FILE,
        entries: [
          { path: 'src/a.ts', severity: 'error', line: 3, column: 5, message: 'bad', source: 'ts' },
          {
            path: 'src/a.ts',
            severity: 'warning',
            line: 1,
            column: 1,
            message: 'unused',
            source: 'ts',
          },
        ],
      },
      { file: OTHER, entries: [] },
    ])
  })

  it('gives up waiting for a first report, ignoring other files’ reports', async () => {
    const { verify } = editor()
    const started = Date.now()
    const pending = verify.diagnosticsAfterEdit([FILE], new AbortController().signal)
    report('/ws/unrelated.ts')
    await pending
    expect(Date.now() - started).toBeGreaterThanOrEqual(SETTLE.firstMs - 5)
  })

  it('stops waiting at the cap while the reports keep coming, and at once on a stop', async () => {
    const { verify } = editor()
    const started = Date.now()
    const chatter = setInterval(() => {
      report(FILE.absolute)
    }, 5)
    try {
      await verify.diagnosticsAfterEdit([FILE], new AbortController().signal)
    } finally {
      clearInterval(chatter)
    }
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(SETTLE.maxMs - 5)
    const stop = new AbortController()
    const quick = Date.now()
    const pending = verify.diagnosticsAfterEdit([FILE], stop.signal)
    stop.abort()
    await pending
    expect(Date.now() - quick).toBeLessThan(SETTLE.firstMs)
  })

  it('matches files case-insensitively on Windows, and does not show a file already shown', async () => {
    const { verify } = editor('win32')
    window.visibleTextEditors = [fakeEditor(Uri.file('/WS/Src/a.ts'))]
    vi.mocked(languages.getDiagnostics).mockReturnValue([
      [Uri.file('/WS/SRC/A.TS'), [diagnostic(0, 0, 0, 'bad')]],
    ])
    const pending = verify.diagnosticsAfterEdit([FILE], new AbortController().signal)
    report('/WS/src/A.ts')
    const [only] = await pending
    expect(only?.entries.map((entry) => entry.message)).toEqual(['bad'])
    expect(shownDocument).not.toHaveBeenCalled()
  })

  it('logs a file it cannot open or show, and does not wait for it', async () => {
    const { verify, channel } = editor()
    vi.mocked(workspace.openTextDocument).mockRejectedValueOnce(new Error('too large'))
    vi.mocked(shownDocument).mockRejectedValueOnce(new Error('no editor group'))
    const started = Date.now()
    const files = await verify.diagnosticsAfterEdit([FILE, OTHER], new AbortController().signal)
    expect(Date.now() - started).toBeLessThan(SETTLE.firstMs)
    expect(files.map((result) => result.entries)).toEqual([[], []])
    const logged = logLines(channel).join('\n')
    expect(logged).toContain('Verify: src/a.ts could not be opened for diagnostics: too large')
    expect(logged).toContain('Verify: src/b.ts could not be shown for diagnostics: no editor group')
  })

  it('settles one file for the diagnostics tool', async () => {
    const { verify } = editor()
    const pending = verify.settleFile(FILE.absolute, FILE.relative)
    setTimeout(() => {
      report(FILE.absolute)
    }, 5)
    await pending
    expect(vi.mocked(shownDocument).mock.calls[0]?.[0].fsPath).toBe(FILE.absolute)
  })
})

function documentWith(state: DocumentState): void {
  vi.mocked(workspace.openTextDocument).mockResolvedValue(fakeDocument(state))
}

describe('formatAfterEdit', () => {
  it('applies the formatter’s edits to what the tool wrote, with the editor’s options', async () => {
    const { verify } = editor()
    documentWith({ text: 'let  a=1\nlet b=2\n' })
    vi.mocked(commands.executeCommand).mockResolvedValue([
      textEdit([0, 3], [0, 5], ' '),
      textEdit([0, 6], [0, 7], ' = '),
      textEdit([1, 5], [1, 6], ' = '),
    ])
    expect(await verify.formatAfterEdit(FILE.absolute, 'let  a=1\nlet b=2\n')).toBe(
      'let a = 1\nlet b = 2\n',
    )
    const [command, uri, options] = vi.mocked(commands.executeCommand).mock.calls[0] ?? []
    expect(command).toBe('vscode.executeFormatDocumentProvider')
    expect((uri as vscode.Uri).fsPath).toBe(FILE.absolute)
    expect(options).toEqual({ tabSize: 2, insertSpaces: true })
  })

  it('keeps a BOM and writes the formatter’s line breaks as the file’s CRLF', async () => {
    const { verify } = editor()
    documentWith({ text: 'a\r\nb\r\n', eol: EndOfLine.CRLF })
    vi.mocked(commands.executeCommand).mockResolvedValue([textEdit([0, 1], [0, 1], ';\nx')])
    expect(await verify.formatAfterEdit(FILE.absolute, '\u{FEFF}a\r\nb\r\n')).toBe(
      '\u{FEFF}a;\r\nx\r\nb\r\n',
    )
  })

  it('waits for an open document to catch up with the file before formatting it', async () => {
    const { verify } = editor()
    const state: DocumentState = { text: 'old' }
    documentWith(state)
    setTimeout(() => {
      state.text = 'new '
    }, 15)
    vi.mocked(commands.executeCommand).mockResolvedValue([textEdit([0, 3], [0, 4], '')])
    expect(await verify.formatAfterEdit(FILE.absolute, 'new ')).toBe('new')
  })

  it('formats nothing it cannot trust: stale, dirty, changed meanwhile, overlapping, slow', async () => {
    const { verify, channel } = editor()
    documentWith({ text: 'never caught up' })
    expect(await verify.formatAfterEdit(FILE.absolute, 'x')).toBeUndefined()
    expect(logLines(channel).join('\n')).toContain('the editor did not show the new text')
    expect(commands.executeCommand).not.toHaveBeenCalled()

    documentWith({ text: 'x', isDirty: true })
    expect(await verify.formatAfterEdit(FILE.absolute, 'y')).toBeUndefined()

    const moving: DocumentState = { text: 'x' }
    documentWith(moving)
    vi.mocked(commands.executeCommand).mockImplementationOnce(() => {
      moving.text = 'typed meanwhile'
      return Promise.resolve([textEdit([0, 0], [0, 1], 'y')])
    })
    expect(await verify.formatAfterEdit(FILE.absolute, 'x')).toBeUndefined()

    documentWith({ text: 'abcdef' })
    vi.mocked(commands.executeCommand).mockResolvedValueOnce([
      textEdit([0, 1], [0, 4], ''),
      textEdit([0, 3], [0, 5], ''),
    ])
    expect(await verify.formatAfterEdit(FILE.absolute, 'abcdef')).toBeUndefined()
    expect(logLines(channel).join('\n')).toContain("the formatter's edits overlap")

    vi.mocked(commands.executeCommand).mockReturnValueOnce(
      new Promise((resolve) => {
        setTimeout(() => {
          resolve([textEdit([0, 0], [0, 1], 'z')])
        }, FORMAT.formatMs * 3)
      }),
    )
    expect(await verify.formatAfterEdit(FILE.absolute, 'abcdef')).toBeUndefined()
  })

  it('returns nothing when there is no formatter or it changes nothing', async () => {
    const { verify } = editor()
    documentWith({ text: 'same' })
    vi.mocked(commands.executeCommand).mockResolvedValueOnce(undefined)
    expect(await verify.formatAfterEdit(FILE.absolute, 'same')).toBeUndefined()
    vi.mocked(commands.executeCommand).mockResolvedValueOnce([])
    expect(await verify.formatAfterEdit(FILE.absolute, 'same')).toBeUndefined()
    vi.mocked(commands.executeCommand).mockResolvedValueOnce([textEdit([0, 0], [0, 4], 'same')])
    expect(await verify.formatAfterEdit(FILE.absolute, 'same')).toBeUndefined()
  })
})
