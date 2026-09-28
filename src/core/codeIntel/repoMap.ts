// The repo map (M67, PLAN.md D49; Aider's idea over VS Code's services):
// the workspace's files ranked by how often other files use the names they
// define, each with its most used definitions, within a token budget. The
// names are counted in the files' text (read confined, like the search
// tool's); where each widely used name is defined comes from the workspace
// symbols of VS Code's language services. A name defined in several files
// shares its weight among them. The lookups stop at the time budget or a
// Stop, and the map then says it is partial.

import {
  MODEL_TEXT,
  REPO_MAP_CHARS_PER_TOKEN,
  REPO_MAP_CONCURRENCY,
  REPO_MAP_MAX_FILE_CHARS,
  REPO_MAP_MAX_FILES,
  REPO_MAP_MAX_LOOKUPS,
  REPO_MAP_MIN_NAME_CHARS,
  REPO_MAP_PROMPT_TIME_BUDGET_MS,
  REPO_MAP_PROMPT_TOKENS,
  REPO_MAP_SYMBOLS_PER_FILE,
  UI_TEXT,
} from '../../shared/constants'
import { fill } from '../../shared/l10n/text'
import { withDeadline } from '../timeouts'
import {
  ask,
  bareName,
  type CodeIntelDeps,
  CodeIntelQuery,
  CodeIntelRefusal,
  compareText,
  joinLines,
  kindName,
} from './codeIntelQuery'
import type { CodePosition, CodeSymbol } from './languageService'

export interface RepoMapOptions {
  readonly maxTokens: number
  readonly timeBudgetMs: number
  readonly signal?: AbortSignal | undefined
}

// A name as most languages spell one: a letter, `_` or `$`, then those or digits.
const NAME = /[\p{L}_$][\p{L}\p{N}_$]*/gu
const INDENT = '  '
const BUDGET_SPENT = 'the repo map time budget is spent'

interface Definition {
  readonly name: string
  readonly kind: number
  readonly at: CodePosition
  weight: number
}

interface RankedFile {
  readonly relative: string
  score: number
  readonly definitions: Definition[]
}

/** Each name of `min` characters or more in the text, with how often it occurs. */
function countNames(text: string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const [name] of text.matchAll(NAME)) {
    if (name.length >= REPO_MAP_MIN_NAME_CHARS) {
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
  }
  return counts
}

/** The time budget and the Stop that end the map's work early. */
interface Limits {
  readonly isOver: () => boolean
  readonly remainingMs: () => number
  /** Settles when the turn is stopped; never when there is no turn. */
  readonly stopped: Promise<void>
}

/**
 * Runs `work` over `items`, a few at a time, until the limits say stop;
 * returns how many ran. A batch still running when the time is up or the
 * turn is stopped is left to finish on its own.
 */
async function inBatches<T>(
  items: readonly T[],
  limits: Limits,
  work: (item: T) => Promise<void>,
): Promise<number> {
  const { isOver, remainingMs, stopped } = limits
  let done = 0
  while (done < items.length && !isOver()) {
    const batch = items.slice(done, done + REPO_MAP_CONCURRENCY)
    try {
      const running = withDeadline(
        Promise.all(
          batch.map(async (item) => {
            await work(item)
          }),
        ),
        Math.max(remainingMs(), 1),
        BUDGET_SPENT,
      )
      const didFinish = async () => {
        await running
        return true
      }
      const wasStopped = async () => {
        await stopped
        return false
      }
      const isFinished = await Promise.race([didFinish(), wasStopped()])
      if (!isFinished) {
        return done
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'DeadlineError') {
        return done
      }
      throw error
    }
    done += batch.length
  }
  return done
}

/** Name → file → how often the file uses it, over the files that could be read. */
async function readUses(
  query: CodeIntelQuery,
  files: readonly string[],
  limits: Limits,
): Promise<ReadonlyMap<string, ReadonlyMap<string, number>>> {
  const uses = new Map<string, Map<string, number>>()
  await inBatches(files, limits, async (relative) => {
    let text: string | undefined
    try {
      const file = await query.confine(relative)
      text = await query.deps.io.readFile(file.checkedAbsolute, file.checkedAbsolute)
    } catch {
      // A file that is not confined UTF-8 text is left out of the counts, as
      // the search tool leaves it out.
      return
    }
    if (text === undefined || text.length > REPO_MAP_MAX_FILE_CHARS) {
      return
    }
    for (const [name, count] of countNames(text)) {
      const perFile = uses.get(name) ?? new Map<string, number>()
      perFile.set(relative, count)
      uses.set(name, perFile)
    }
  })
  return uses
}

/** The names used by two files or more, the most widely used first. */
function candidates(uses: ReadonlyMap<string, ReadonlyMap<string, number>>): readonly string[] {
  return [...uses]
    .filter(([, perFile]) => perFile.size > 1)
    .toSorted(([a, left], [b, right]) => right.size - left.size || compareText(a, b))
    .slice(0, REPO_MAP_MAX_LOOKUPS)
    .map(([name]) => name)
}

function rank(
  definitions: ReadonlyMap<string, readonly { relative: string; symbol: CodeSymbol }[]>,
  uses: ReadonlyMap<string, ReadonlyMap<string, number>>,
): readonly RankedFile[] {
  const files = new Map<string, RankedFile>()
  const ranked: RankedFile[] = []
  for (const [name, found] of definitions) {
    const definers = new Set(found.map((entry) => entry.relative))
    const users = uses.get(name) ?? new Map<string, number>()
    let usedElsewhere = 0
    for (const [relative, count] of users) {
      if (!definers.has(relative)) {
        usedElsewhere += count
      }
    }
    if (usedElsewhere === 0) {
      continue
    }
    const weight = usedElsewhere / definers.size
    const credited = new Set<string>()
    for (const { relative, symbol } of found) {
      // Overloads and redeclarations in one file count once.
      if (credited.has(relative)) {
        continue
      }
      credited.add(relative)
      let file = files.get(relative)
      if (file === undefined) {
        file = { relative, score: 0, definitions: [] }
        files.set(relative, file)
        ranked.push(file)
      }
      file.score += weight
      file.definitions.push({ name, kind: symbol.kind, at: symbol.selection.start, weight })
    }
  }
  return ranked.toSorted((a, b) => b.score - a.score || compareText(a.relative, b.relative))
}

function fileBlock(file: RankedFile): string {
  const shown = file.definitions
    .toSorted((a, b) => b.weight - a.weight || a.at.line - b.at.line || compareText(a.name, b.name))
    .slice(0, REPO_MAP_SYMBOLS_PER_FILE)
    .toSorted((a, b) => a.at.line - b.at.line || a.at.character - b.at.character)
    .map(
      (definition) =>
        `${INDENT}${String(definition.at.line + 1)}: ${kindName(definition.kind)} ${definition.name}`,
    )
  return [file.relative, ...shown].join('\n')
}

/** The ranked files as text, as many as the budget holds. */
function render(
  ranked: readonly RankedFile[],
  maxTokens: number,
  notes: readonly string[],
): string {
  const budget = maxTokens * REPO_MAP_CHARS_PER_TOKEN
  const blocks: string[] = []
  let used = MODEL_TEXT.repoMapLead.length
  for (const file of ranked) {
    const block = fileBlock(file)
    if (used + block.length + 1 > budget) {
      break
    }
    blocks.push(block)
    used += block.length + 1
  }
  const hidden = ranked.length - blocks.length
  return joinLines([
    MODEL_TEXT.repoMapLead,
    ...blocks,
    ...(hidden > 0 ? [fill(MODEL_TEXT.codeIntelMore, { count: String(hidden) })] : []),
    ...notes,
  ])
}

interface BuiltMap {
  readonly ranked: readonly RankedFile[]
  /** What the map could not cover: lookups cut short, files past the cap. */
  readonly notes: readonly string[]
}

/**
 * The ranked files, or the refusal when no language service answers
 * workspace symbols (the map would be empty for want of one, not for want
 * of code).
 */
async function buildMap(query: CodeIntelQuery, options: RepoMapOptions): Promise<BuiltMap> {
  const { now } = query.deps
  const deadline = now() + options.timeBudgetMs
  const { signal } = options
  const limits: Limits = {
    isOver: () => signal?.aborted === true || now() >= deadline,
    remainingMs: () => deadline - now(),
    stopped: new Promise((resolve) => {
      signal?.addEventListener(
        'abort',
        () => {
          resolve()
        },
        { once: true },
      )
    }),
  }
  const found = await query.deps.io.listFiles()
  const listed = found.toSorted((a, b) => compareText(a, b))
  const files = listed.slice(0, REPO_MAP_MAX_FILES)
  const uses = await readUses(query, files, limits)
  const names = candidates(uses)
  const definitions = new Map<string, { relative: string; symbol: CodeSymbol }[]>()
  let answered = 0
  const looked = await inBatches(names, limits, async (name) => {
    const found = await ask(query.service.workspaceSymbols(name))
    answered += found.length
    const exact = await Promise.all(
      found
        .filter((symbol) => bareName(symbol) === name)
        .map(async (symbol) => ({ symbol, file: await query.place(symbol.location.path) })),
    )
    const inside = exact.flatMap(({ symbol, file }) =>
      file === undefined ? [] : [{ relative: file.relative, symbol }],
    )
    if (inside.length > 0) {
      definitions.set(name, inside)
    }
  })
  if (answered === 0 && looked > 0) {
    throw new CodeIntelRefusal(MODEL_TEXT.repoMapNoService, UI_TEXT.repoMapNoService)
  }
  const notes = [
    ...(looked < names.length
      ? [fill(MODEL_TEXT.repoMapPartial, { done: String(looked), total: String(names.length) })]
      : []),
    ...(files.length < listed.length
      ? [
          fill(MODEL_TEXT.repoMapFilesCapped, {
            count: String(files.length),
            total: String(listed.length),
          }),
        ]
      : []),
  ]
  return { ranked: rank(definitions, uses), notes }
}

/** The `repo_map` tool's answer within `maxTokens`. */
export async function repoMap(query: CodeIntelQuery, options: RepoMapOptions): Promise<string> {
  const { ranked, notes } = await buildMap(query, options)
  return ranked.length === 0
    ? joinLines([MODEL_TEXT.repoMapEmpty, ...notes])
    : render(ranked, options.maxTokens, notes)
}

/**
 * The system prompt's section (opt in, M67): the map within its own budget
 * and time, undefined when no file ranks. Rejects with the refusal when no
 * language service answers.
 */
export async function repoMapSection(
  deps: CodeIntelDeps,
  signal: AbortSignal,
): Promise<string | undefined> {
  const options = {
    maxTokens: REPO_MAP_PROMPT_TOKENS,
    timeBudgetMs: REPO_MAP_PROMPT_TIME_BUDGET_MS,
    signal,
  }
  const { ranked, notes } = await buildMap(new CodeIntelQuery(deps), options)
  return ranked.length === 0
    ? undefined
    : [
        MODEL_TEXT.repoMapSection,
        MODEL_TEXT.repoMapSectionLead,
        render(ranked, options.maxTokens, notes),
      ].join('\n\n')
}
