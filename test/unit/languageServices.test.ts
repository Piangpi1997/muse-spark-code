// VS Code's language services as the code intelligence tools read them
// (M67): each `vscode.execute…` command's result converted to plain data,
// a result that is no file left without a path, and a rename's file
// operations noticed.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import { vscodeLanguageServices } from '../../src/host/codeIntel/languageServices'
import { VSCODE_COMMANDS } from '../../src/shared/constants'

const FILE = '/ws/a.ts'
const AT = { line: 1, character: 2 }
const answers = new Map<string, (...args: unknown[]) => unknown>()

function range(line: number, from: number, to: number) {
  return { start: { line, character: from }, end: { line, character: to } }
}

const fileUri = vscode.Uri.file(FILE)
const virtualUri = { scheme: 'untitled', fsPath: 'Untitled-1' }

beforeEach(() => {
  answers.clear()
  vi.mocked(vscode.commands.executeCommand).mockReset()
  vi.mocked(vscode.commands.executeCommand).mockImplementation(((
    command: string,
    ...args: unknown[]
  ) => Promise.resolve(answers.get(command)?.(...args))) as typeof vscode.commands.executeCommand)
})

describe('vscodeLanguageServices', () => {
  const services = vscodeLanguageServices()

  it('opens a document without showing it', async () => {
    vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({
      languageId: 'typescript',
      getText: () => 'text',
      isDirty: true,
    } as unknown as vscode.TextDocument)
    expect(await services.open(FILE)).toEqual({
      languageId: 'typescript',
      text: 'text',
      isDirty: true,
    })
  })

  it('reads locations and links, asking at the position given', async () => {
    answers.set(VSCODE_COMMANDS.executeDefinitionProvider, (uri, position) => {
      expect(uri).toMatchObject({ fsPath: FILE })
      expect(position).toMatchObject(AT)
      return [
        { uri: fileUri, range: range(0, 1, 2) },
        { targetUri: fileUri, targetRange: range(3, 0, 9), targetSelectionRange: range(3, 4, 5) },
        { targetUri: virtualUri, targetRange: range(4, 0, 1) },
      ]
    })
    answers.set(VSCODE_COMMANDS.executeReferenceProvider, () => [
      { uri: fileUri, range: range(7, 0, 3) },
    ])
    expect(await services.definitions(FILE, AT)).toEqual([
      { path: FILE, range: range(0, 1, 2) },
      { path: FILE, range: range(3, 4, 5) },
      { path: undefined, range: range(4, 0, 1) },
    ])
    expect(await services.references(FILE, AT)).toEqual([{ path: FILE, range: range(7, 0, 3) }])
    answers.clear()
    expect(await services.definitions(FILE, AT)).toEqual([])
    expect(await services.references(FILE, AT)).toEqual([])
    expect(await services.hover(FILE, AT)).toEqual([])
    expect(await services.documentSymbols(FILE)).toEqual([])
    expect(await services.workspaceSymbols('x')).toEqual([])
  })

  it('reads hover parts as Markdown, code fenced, an unknown shape as it came', async () => {
    answers.set(VSCODE_COMMANDS.executeHoverProvider, () => [
      { contents: ['plain', { language: 'ts', value: 'let x' }, { value: '**md**' }, 42] },
    ])
    expect(await services.hover(FILE, AT)).toEqual(['plain', '```ts\nlet x\n```', '**md**', '42'])
  })

  it('reads document symbols in both of their shapes, and workspace symbols', async () => {
    const child = {
      name: 'run',
      kind: 5,
      detail: '()',
      range: range(2, 0, 9),
      selectionRange: range(2, 2, 5),
      children: [],
    }
    answers.set(VSCODE_COMMANDS.executeDocumentSymbolProvider, () => [
      {
        name: 'Host',
        kind: 4,
        detail: '',
        range: range(1, 0, 20),
        selectionRange: range(1, 6, 10),
        children: [child],
      },
      {
        name: 'flat',
        kind: 12,
        containerName: 'Host',
        location: { uri: fileUri, range: range(9, 0, 4) },
      },
    ])
    answers.set(VSCODE_COMMANDS.executeWorkspaceSymbolProvider, (query) => [
      {
        name: String(query),
        kind: 11,
        containerName: '',
        location: { uri: virtualUri, range: range(0, 0, 1) },
      },
    ])
    const [host, flat] = await services.documentSymbols(FILE)
    expect(host).toMatchObject({
      name: 'Host',
      selection: range(1, 6, 10),
      location: { path: FILE, range: range(1, 0, 20) },
      children: [{ name: 'run', detail: '()', selection: range(2, 2, 5) }],
    })
    expect(flat).toMatchObject({
      name: 'flat',
      container: 'Host',
      selection: range(9, 0, 4),
      children: [],
    })
    expect(await services.workspaceSymbols('greet')).toMatchObject([
      { name: 'greet', kind: 11, location: { path: undefined } },
    ])
  })

  it('prepares a call hierarchy and reads its calls either way', async () => {
    const item = {
      name: 'greet',
      kind: 11,
      uri: fileUri,
      range: range(0, 0, 30),
      selectionRange: range(0, 16, 21),
    }
    const caller = { ...item, name: 'main', detail: 'main.ts' }
    answers.set(VSCODE_COMMANDS.prepareCallHierarchy, () => [item])
    answers.set(VSCODE_COMMANDS.provideIncomingCalls, () => [
      { from: caller, fromRanges: [range(5, 2, 7)] },
    ])
    answers.set(VSCODE_COMMANDS.provideOutgoingCalls, () => [
      { to: caller, fromRanges: [range(1, 2, 7)] },
    ])
    expect(await services.callHierarchy(FILE, AT, 'incoming')).toMatchObject({
      item: { name: 'greet', selection: range(0, 16, 21) },
      calls: [{ symbol: { name: 'main', detail: 'main.ts' }, ranges: [range(5, 2, 7)] }],
    })
    expect(await services.callHierarchy(FILE, AT, 'outgoing')).toMatchObject({
      calls: [{ symbol: { name: 'main' }, ranges: [range(1, 2, 7)] }],
    })
    answers.set(VSCODE_COMMANDS.provideIncomingCalls, () => undefined)
    answers.set(VSCODE_COMMANDS.provideOutgoingCalls, () => undefined)
    expect(await services.callHierarchy(FILE, AT, 'incoming')).toMatchObject({ calls: [] })
    expect(await services.callHierarchy(FILE, AT, 'outgoing')).toMatchObject({ calls: [] })
    answers.set(VSCODE_COMMANDS.prepareCallHierarchy, () => [])
    expect(await services.callHierarchy(FILE, AT, 'incoming')).toBeUndefined()
  })

  it("reads a rename's edits, notices file operations, and passes a refusal on", async () => {
    const edits = [{ range: range(0, 16, 21), newText: 'welcome' }]
    let size = 1
    answers.set(VSCODE_COMMANDS.executeDocumentRenameProvider, (_uri, _position, newName) => {
      expect(newName).toBe('welcome')
      return { size, entries: () => [[fileUri, edits]] }
    })
    expect(await services.rename(FILE, AT, 'welcome')).toEqual({
      files: [{ path: FILE, edits: [{ range: range(0, 16, 21), newText: 'welcome' }] }],
      hasFileOperations: false,
    })
    size = 2
    expect(await services.rename(FILE, AT, 'welcome')).toMatchObject({ hasFileOperations: true })
    answers.delete(VSCODE_COMMANDS.executeDocumentRenameProvider)
    expect(await services.rename(FILE, AT, 'welcome')).toEqual({
      files: [],
      hasFileOperations: false,
    })
    vi.mocked(vscode.commands.executeCommand).mockImplementation(((command: string) =>
      command === VSCODE_COMMANDS.prepareRename
        ? Promise.reject(new Error('You cannot rename this element.'))
        : Promise.resolve(undefined)) as typeof vscode.commands.executeCommand)
    await expect(services.rename(FILE, AT, 'welcome')).rejects.toThrow(
      'You cannot rename this element.',
    )
  })
})
