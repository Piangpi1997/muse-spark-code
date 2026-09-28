// A saved plan as a Markdown file (M79, PLAN.md D49), after Muse Code's own
// convention: its bundled `plan` skill (Muse Code 1.4.0) saves a plan to
// `.agents/plans/YYYY-MM-DD-<slug>.md`, a short numeric suffix when that
// name is taken, and the file's content is exactly the plan's body. The
// name it gets, the body a reply holds, how a file is read back, and the
// steps that seed a new conversation's todo list. No file system, no
// `vscode`.

import { createHash } from 'node:crypto'
import {
  MUSE_PLAN_HANDOFF_LEAD,
  MUSE_PLAN_HANDOFF_TAIL,
  PLAN_FILE_EXTENSION,
  PLAN_LOG_HASH_CHARS,
  PLAN_SLUG_FALLBACK,
  PLAN_SLUG_MAX_CHARS,
  PLAN_STEP_MAX_CHARS,
  PLAN_STEPS_MAX,
  PLAN_TITLE_MAX_CHARS,
} from '../../shared/constants'

/** A plan read back from its file. */
export interface PlanDocument {
  /** Its first top-level heading, else its file name. */
  readonly title: string
  /** The file whole: the plan as the model wrote it. */
  readonly body: string
}

/** What a plan file is written from. */
export interface PlanContent {
  /** What the file is named after. */
  readonly title: string
  readonly savedAt: Date
  /** The plan, written byte for byte. */
  readonly text: string
}

const LINE_BREAK = /\r?\n/
const CODE_FENCE = /^ {0,3}(?:```|~~~)/
const TOP_HEADING = /^ {0,3}#\s+(.*?)\s*#*\s*$/
// "Plan", "Plan:", "Plan how to", "Implementation plan —" say nothing about the task.
const GENERIC_PLAN_LEAD = /^(?:implementation\s+)?plan\b(?:\s+how\s+to\b)?[\s:.\-–—]*/i
// A top-level item starts at most one space in; a nested one is indented under its parent.
const ORDERED_ITEM = /^ ?\d{1,9}[.)]\s+(.*)$/
const BULLET_ITEM = /^ ?[-*+]\s+(.*)$/
const TASK_BOX = /^\[[ xX]\]\s+/
const INLINE_MARKUP = /\*\*|__|`/g
const WHITESPACE = /\s+/g
// Letters, their marks (Devanagari's vowel signs, Thai's tones) and digits.
const NOT_SLUG = /[^\p{L}\p{M}\p{N}]+/gu
// The accents of Latin, Greek and Cyrillic letters once decomposed; kana's
// voicing marks and Hangul's jamo are left to recompose.
const COMBINING_ACCENTS = /[\u{300}-\u{36F}]+/gu
const EDGE_HYPHENS = /^-+|-+$/g
const LEADING_BREAKS = /^(?:\r?\n)+/
const TRAILING_BREAKS = /(?:\r?\n)+$/
// A separator, a drive or stream colon, a control character (a line break
// would reach the brief unquoted) or a format character (a right-to-left
// override would disguise the name in Plans…): never part of a plan's name.
const UNSAFE_NAME_CHARACTER = /[\\/:\p{Cc}\p{Cf}]/u
// Raw HTML outside code, which the panel's Markdown view does not show: a
// comment, a declaration or processing instruction, or a tag, even one
// whose attributes go on past the line. A tag name ends at a space, `/`,
// `>` or the line's end, so a Markdown autolink (`<https://…>`, `<a@b.c>`),
// which the panel shows, is not one.
const INLINE_CODE = /`[^`\n]*`/g
const HIDDEN_MARKUP = /<!--|<[!?][A-Za-z]|<!\[|<\/?[A-Za-z][\w-]*(?=[\s/>]|$)/
const ISO_DATE_CHARS = 10
const DATE_PAD = 2
const ELLIPSIS = '…'

// Characters as the user sees them: a cut never splits a pair or a cluster.
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function graphemes(text: string): readonly string[] {
  return Array.from(GRAPHEMES.segment(text), (part) => part.segment)
}

function oneLine(text: string): string {
  return text.replaceAll(WHITESPACE, ' ').trim()
}

/** At most `maxChars` characters, never split, an ellipsis when cut. */
function cut(text: string, maxChars: number): string {
  const characters = graphemes(text)
  return characters.length <= maxChars
    ? text
    : `${characters
        .slice(0, maxChars - 1)
        .join('')
        .trimEnd()}${ELLIPSIS}`
}

/** The lines outside fenced code blocks. */
function proseLines(text: string): readonly string[] {
  const lines: string[] = []
  let isInFence = false
  for (const line of text.split(LINE_BREAK)) {
    if (CODE_FENCE.test(line)) {
      isInFence = !isInFence
      continue
    }
    if (!isInFence) {
      lines.push(line)
    }
  }
  return lines
}

/** The text of the first top-level (`# `) heading outside code, if any. */
function topHeading(text: string): string | undefined {
  for (const line of proseLines(text)) {
    const heading = oneLine((TOP_HEADING.exec(line)?.[1] ?? '').replaceAll(INLINE_MARKUP, ''))
    if (heading !== '') {
      return heading
    }
  }
  return undefined
}

/**
 * The plan a reply holds. A Muse Code plan reply opens and closes with its
 * `plan` skill's handoff (captured live 2026-09-27, docs/certification/m79.md):
 * the plan is what lies between, the blank lines around it dropped, and
 * nothing else changed. Any other reply is the plan whole.
 */
export function planBody(reply: string): string {
  if (!reply.startsWith(MUSE_PLAN_HANDOFF_LEAD)) {
    return reply
  }
  const inner = reply.slice(MUSE_PLAN_HANDOFF_LEAD.length).replace(LEADING_BREAKS, '')
  const withoutTail = inner.trimEnd().endsWith(MUSE_PLAN_HANDOFF_TAIL)
    ? inner.trimEnd().slice(0, -MUSE_PLAN_HANDOFF_TAIL.length)
    : inner
  const body = withoutTail.replace(TRAILING_BREAKS, '')
  return body.trim() === '' ? reply : body
}

/**
 * What a plan is named after: its top-level heading, unless that only says
 * "Plan"; else the first line of the prompt that asked for it, its "Plan how
 * to" dropped; else `fallback`.
 */
export function planTitle(text: string, prompt: string | undefined, fallback: string): string {
  const heading = topHeading(text)?.replace(GENERIC_PLAN_LEAD, '').trim()
  const request = (prompt ?? '')
    .split(LINE_BREAK)
    .map((line) => oneLine(line).replace(GENERIC_PLAN_LEAD, ''))
    .find((line) => line !== '')
  const title = heading === undefined || heading === '' ? (request ?? fallback) : heading
  return cut(title, PLAN_TITLE_MAX_CHARS)
}

/**
 * The file-name form of a title: letters and digits of any script, lower
 * case, accents dropped, everything else one hyphen, cut to a length.
 */
export function planSlug(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replaceAll(COMBINING_ACCENTS, '')
    .normalize('NFC')
    .toLowerCase()
    .replaceAll(NOT_SLUG, '-')
    .replaceAll(EDGE_HYPHENS, '')
  // Cut by characters: a pair cut in half would reach the disk as U+FFFD.
  const kept = graphemes(slug).slice(0, PLAN_SLUG_MAX_CHARS).join('').replaceAll(EDGE_HYPHENS, '')
  return kept === '' ? PLAN_SLUG_FALLBACK : kept
}

/**
 * How the log names a plan file: its date and a short hash of its name,
 * never the slug, which is drawn from what the user or the model wrote (M39).
 */
export function planLogName(fileName: string): string {
  const hash = createHash('sha256').update(fileName).digest('hex').slice(0, PLAN_LOG_HASH_CHARS)
  return `${fileName.slice(0, ISO_DATE_CHARS)}-#${hash}${PLAN_FILE_EXTENSION}`
}

/**
 * Whether the plan holds raw HTML outside code: a comment or a tag, which the
 * panel's Markdown view leaves out, so the user did not see all of what the
 * model would be sent.
 */
export function hasHiddenMarkup(text: string): boolean {
  return proseLines(text).some((line) => HIDDEN_MARKUP.test(line.replaceAll(INLINE_CODE, '')))
}

/** `2026-09-27`: the local calendar day. */
function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(DATE_PAD, '0')
  const day = String(date.getDate()).padStart(DATE_PAD, '0')
  return `${String(date.getFullYear())}-${month}-${day}`
}

/** `<date>-<slug>.md`, or `<date>-<slug>-<n>.md` from the second attempt on. */
export function planFileName(savedAt: Date, slug: string, attempt: number): string {
  const suffix = attempt <= 1 ? '' : `-${String(attempt)}`
  return `${localDay(savedAt)}-${slug}${suffix}${PLAN_FILE_EXTENSION}`
}

/** Reads a plan file back; `fileName` names it when no top-level heading does. */
export function parsePlanFile(content: string, fileName: string): PlanDocument {
  const bareName = fileName.endsWith(PLAN_FILE_EXTENSION)
    ? fileName.slice(0, -PLAN_FILE_EXTENSION.length)
    : fileName
  return { title: cut(topHeading(content) ?? bareName, PLAN_TITLE_MAX_CHARS), body: content }
}

/** A list item as a task: its task box and inline markup gone, one line, cut. */
function stepText(item: string): string {
  return cut(oneLine(item.replace(TASK_BOX, '').replaceAll(INLINE_MARKUP, '')), PLAN_STEP_MAX_CHARS)
}

/**
 * The plan's steps: its top-level numbered items outside code, or, when it
 * numbers none, its top-level bullets. Nested items and continuation lines
 * belong to their step. At most PLAN_STEPS_MAX.
 */
export function planSteps(body: string): readonly string[] {
  const ordered: string[] = []
  const bullets: string[] = []
  for (const line of proseLines(body)) {
    const numbered = ORDERED_ITEM.exec(line)?.[1]
    const bulleted = numbered === undefined ? BULLET_ITEM.exec(line)?.[1] : undefined
    const text = stepText(numbered ?? bulleted ?? '')
    if (text === '') {
      continue
    }
    ;(numbered === undefined ? bullets : ordered).push(text)
  }
  return (ordered.length > 0 ? ordered : bullets).slice(0, PLAN_STEPS_MAX)
}

/** The steps as numbered lines, as the model is told its todo list was set. */
export function numberedSteps(steps: readonly string[]): string {
  return steps.map((step, index) => `${String(index + 1)}. ${step}`).join('\n')
}

/** Whether a name is a plan file's own: one path segment ending in `.md`. */
export function isPlanFileName(name: string): boolean {
  return (
    name.endsWith(PLAN_FILE_EXTENSION) &&
    name.length > PLAN_FILE_EXTENSION.length &&
    !name.startsWith('.') &&
    !UNSAFE_NAME_CHARACTER.test(name)
  )
}
