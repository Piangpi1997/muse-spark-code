// A fetched HTML page as Markdown for the model to read (M69, PLAN.md D49):
// headings, paragraphs, lists, links, emphasis, code blocks, quotes and
// tables kept; scripts, styles, forms' controls, embedded media, SVG and what
// the page's own markup hides left out (a stylesheet's hiding is not seen). A
// single pass over the text, linear in its length whatever the markup (a
// page is untrusted input, so no regular expression walks its structure):
// the tokenizer jumps from one `<` to the next, the renderer keeps a small
// stack of open elements, and the output is bounded, so a page built to
// expand stops converting at the bound instead of growing. Character
// references are decoded with the `entities` package, the WHATWG list
// (M69's one new dependency, PLAN.md D49).

import { decodeHTML, decodeHTMLAttribute } from 'entities/decode'

export interface MarkdownPage {
  /** The page's `<title>`, whitespace collapsed; undefined when it has none. */
  readonly title: string | undefined
  readonly markdown: string
  /** The conversion stopped at its bound: the page holds more than this. */
  readonly isTruncated: boolean
}

// Elements whose content is text up to their end tag, never markup.
const RAW_TEXT = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
])
// Elements whose whole content is left out: code, media, controls, drawings.
const SKIPPED = new Set([
  'template',
  'svg',
  'math',
  'object',
  'canvas',
  'audio',
  'video',
  'picture',
  'select',
  'button',
  'map',
  'datalist',
])
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])
// HTML's scopes (the parsing algorithm's "has an element in scope"): open
// inside an element a page may leave open, these keep it open.
const BUTTON_SCOPE: ReadonlySet<string> = new Set([
  'applet',
  'button',
  'caption',
  'html',
  'marquee',
  'object',
  'table',
  'td',
  'template',
  'th',
])
const TABLE_SCOPE: ReadonlySet<string> = new Set(['html', 'table', 'template'])
// HTML's special elements but address, div and p: a new list item's search
// for the open one stops at them (nested lists, sections, tables).
const LIST_SCOPE: ReadonlySet<string> = new Set([
  'applet',
  'article',
  'aside',
  'blockquote',
  'body',
  'button',
  'caption',
  'center',
  'colgroup',
  'dd',
  'details',
  'dir',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hgroup',
  'html',
  'li',
  'listing',
  'main',
  'marquee',
  'menu',
  'nav',
  'object',
  'ol',
  'plaintext',
  'pre',
  'search',
  'section',
  'select',
  'summary',
  'table',
  'tbody',
  'td',
  'template',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
])
// The start tags that close an open `<p>`. A table does only outside quirks
// mode, so it is left out: a hidden paragraph then hides it too.
const PARAGRAPH_CLOSERS: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'center',
  'dd',
  'details',
  'dialog',
  'dir',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'li',
  'listing',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'plaintext',
  'pre',
  'search',
  'section',
  'summary',
  'ul',
])
const TABLE_SECTIONS = ['thead', 'tbody', 'tfoot']
const NOTHING: ReadonlySet<string> = new Set()

/**
 * An element a page may leave open (`<p>`, `<li>`, `<td>`): the start tags
 * that close it without its end tag, and what, open inside it, keeps it open.
 */
interface ImpliedEnd {
  readonly closedBy: ReadonlySet<string>
  readonly barriers: ReadonlySet<string>
}

const ITEM_END: ImpliedEnd = { closedBy: new Set(['li']), barriers: LIST_SCOPE }
const TERM_END: ImpliedEnd = { closedBy: new Set(['dt', 'dd']), barriers: LIST_SCOPE }
const CELL_END: ImpliedEnd = {
  closedBy: new Set(['td', 'th', 'tr', ...TABLE_SECTIONS]),
  barriers: TABLE_SCOPE,
}
const SECTION_END: ImpliedEnd = { closedBy: new Set(TABLE_SECTIONS), barriers: TABLE_SCOPE }
const RUBY_END: ImpliedEnd = {
  closedBy: new Set(['rb', 'rt', 'rp', 'rtc']),
  barriers: BUTTON_SCOPE,
}
// Only an end tag, or the end of the page, closes these.
const EXPLICIT_END: ImpliedEnd = { closedBy: NOTHING, barriers: NOTHING }
const IMPLIED_ENDS: ReadonlyMap<string, ImpliedEnd> = new Map([
  ['p', { closedBy: PARAGRAPH_CLOSERS, barriers: BUTTON_SCOPE }],
  ['li', ITEM_END],
  ['dt', TERM_END],
  ['dd', TERM_END],
  ['option', { closedBy: new Set(['option', 'optgroup', 'hr']), barriers: BUTTON_SCOPE }],
  ['optgroup', { closedBy: new Set(['optgroup', 'hr']), barriers: BUTTON_SCOPE }],
  ['tr', { closedBy: new Set(['tr', ...TABLE_SECTIONS]), barriers: TABLE_SCOPE }],
  ['td', CELL_END],
  ['th', CELL_END],
  ['thead', SECTION_END],
  ['tbody', SECTION_END],
  ['tfoot', SECTION_END],
  [
    'caption',
    {
      closedBy: new Set(['caption', 'col', 'colgroup', 'tr', 'td', 'th', ...TABLE_SECTIONS]),
      barriers: TABLE_SCOPE,
    },
  ],
  [
    'colgroup',
    {
      closedBy: new Set(['caption', 'colgroup', 'tr', 'td', 'th', ...TABLE_SECTIONS]),
      barriers: TABLE_SCOPE,
    },
  ],
  ['rb', RUBY_END],
  ['rt', RUBY_END],
  ['rp', RUBY_END],
  ['head', { closedBy: new Set(['body']), barriers: NOTHING }],
  ['body', EXPLICIT_END],
  ['html', EXPLICIT_END],
])
const BLOCKS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'center',
  'dd',
  'details',
  'dialog',
  'dir',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'header',
  'hgroup',
  'html',
  'legend',
  'main',
  'menu',
  'nav',
  'p',
  'section',
  'summary',
])
// Maps, not objects: a tag named `__proto__` must find nothing.
const HEADINGS: ReadonlyMap<string, number> = new Map(
  ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((name, index) => [name, index + 1]),
)
const STRONG_MARK = '**'
const EMPHASIS_MARK = '*'
const STRIKE_MARK = '~~'
const MARKERS: ReadonlyMap<string, string> = new Map([
  ['strong', STRONG_MARK],
  ['b', STRONG_MARK],
  ['em', EMPHASIS_MARK],
  ['i', EMPHASIS_MARK],
  ['cite', EMPHASIS_MARK],
  ['dfn', EMPHASIS_MARK],
  ['del', STRIKE_MARK],
  ['s', STRIKE_MARK],
  ['strike', STRIKE_MARK],
])
const LISTS = new Set(['ul', 'ol', 'menu', 'dir'])
const CODE = new Set(['code', 'kbd', 'samp', 'tt', 'var'])
// Open inline elements past this depth are plain text (see InlineText), and
// quotes and lists past this one are indented no further, so no line's
// prefix grows past a few characters whatever the page nests.
const MAX_INLINE_DEPTH = 32
const MAX_PREFIX_DEPTH = 4
const MAX_TABLE_COLUMNS = 32
// Of a `<title>`, only this much source is read.
const MAX_TITLE_SOURCE_CHARS = 1024
const CELLS = new Set(['td', 'th'])
const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:'])
const IMAGE_SCHEMES = new Set(['http:', 'https:'])
const LANGUAGE_CLASS = ['language-', 'lang-']

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f'])
const NO_BREAK_SPACE = '\u{A0}'
const BACKTICK = '`'
const FENCE_MIN = 3
const LIST_INDENT = '  '
const QUOTE_PREFIX = '> '
const BULLET = '- '
const RULE = '---'
const CELL_SEPARATOR = ' | '
const PIPE = '|'
const ESCAPED_PIPE = String.raw`\|`
const TAG_OPEN = '<'
const TAG_CLOSE = '>'
const END_TAG = '</'
const COMMENT_OPEN = '<!--'
const COMMENT_CLOSE = '-->'
const CDATA_OPEN = '<![CDATA['
const CDATA_CLOSE = ']]>'
const SELF_CLOSE = '/'
const ASSIGN = '='
const QUOTES = new Set(['"', "'"])
// Inline styles that hide an element (a stylesheet's rules are not read).
const HIDING_STYLES = ['display:none', 'visibility:hidden', 'content-visibility:hidden']
const ARIA_HIDDEN = 'true'
const LINE = '\n'
const PARAGRAPH = '\n\n'
const EXCESS_BREAKS = /\n{3,}/g

function isAsciiLetter(char: string | undefined): boolean {
  return char !== undefined && ((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z'))
}

function isNameEnd(char: string | undefined): boolean {
  return char === undefined || WHITESPACE.has(char) || char === SELF_CLOSE || char === TAG_CLOSE
}

/** Runs of white space as one space, a no-break space as a space. */
function collapse(text: string): string {
  let out = ''
  let wasSpace = false
  for (const char of text) {
    const isSpace = WHITESPACE.has(char) || char === NO_BREAK_SPACE
    if (isSpace && !wasSpace) {
      out += ' '
    } else if (!isSpace) {
      out += char
    }
    wasSpace = isSpace
  }
  return out
}

/** The longest run of backticks in the text. */
function longestBacktickRun(text: string): number {
  let longest = 0
  let run = 0
  for (const char of text) {
    run = char === BACKTICK ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  return longest
}

/** Inline code whose fence no backtick inside it can close. */
function inlineCode(text: string): string {
  const fence = BACKTICK.repeat(longestBacktickRun(text) + 1)
  const pad = text.startsWith(BACKTICK) || text.endsWith(BACKTICK) ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

/** A marker around the text's non-space middle: ` a ` becomes ` **a** `. */
function around(inner: string, marker: string): string {
  const trimmed = inner.trim()
  if (trimmed === '') {
    return inner
  }
  const lead = inner.slice(0, inner.length - inner.trimStart().length)
  const trail = inner.slice(inner.trimEnd().length)
  return `${lead}${marker}${trimmed}${marker}${trail}`
}

/** A start or end tag as the tokenizer read it. */
interface Tag {
  readonly name: string
  readonly isEnd: boolean
  readonly isSelfClosing: boolean
  readonly attributes: ReadonlyMap<string, string>
  /** Where the text after the tag begins. */
  readonly next: number
}

/** Reads one attribute's value at `start` (after `=`): quoted or bare. */
function readValue(html: string, start: number): { value: string; next: number } {
  const quote = html[start]
  if (quote !== undefined && QUOTES.has(quote)) {
    const end = html.indexOf(quote, start + 1)
    const stop = end === -1 ? html.length : end
    return { value: html.slice(start + 1, stop), next: end === -1 ? html.length : end + 1 }
  }
  let end = start
  while (end < html.length && !WHITESPACE.has(html[end] ?? '') && html[end] !== TAG_CLOSE) {
    end += 1
  }
  return { value: html.slice(start, end), next: end }
}

function skipSpace(html: string, start: number): number {
  let index = start
  while (index < html.length && WHITESPACE.has(html[index] ?? '')) {
    index += 1
  }
  return index
}

/** The tag starting at `start` (its `<`), or undefined when `<` is plain text there. */
function readTag(html: string, start: number): Tag | undefined {
  const isEnd = html[start + 1] === SELF_CLOSE
  let index = start + (isEnd ? END_TAG.length : TAG_OPEN.length)
  if (!isAsciiLetter(html[index])) {
    return undefined
  }
  const nameStart = index
  while (!isNameEnd(html[index])) {
    index += 1
  }
  const name = html.slice(nameStart, index).toLowerCase()
  const attributes = new Map<string, string>()
  let isSelfClosing = false
  while (index < html.length && html[index] !== TAG_CLOSE) {
    index = skipSpace(html, index)
    if (html[index] === SELF_CLOSE) {
      isSelfClosing = true
      index += 1
      continue
    }
    if (html[index] === TAG_CLOSE || index >= html.length) {
      break
    }
    const attributeStart = index
    while (!isNameEnd(html[index]) && html[index] !== ASSIGN) {
      index += 1
    }
    // A stray `=` before any name is read as a one-character name.
    if (index === attributeStart) {
      index += 1
    }
    const attributeName = html.slice(attributeStart, index).toLowerCase()
    index = skipSpace(html, index)
    let value = ''
    if (html[index] === ASSIGN) {
      const read = readValue(html, skipSpace(html, index + 1))
      value = read.value
      index = read.next
    }
    if (!attributes.has(attributeName)) {
      attributes.set(attributeName, decodeHTMLAttribute(value))
    }
    isSelfClosing = false
  }
  return { name, isEnd, isSelfClosing, attributes, next: Math.min(index + 1, html.length) }
}

/** Where the raw text of `name` ends: the index of its end tag, any case, or the end. */
function rawTextEnd(html: string, from: number, name: string): number {
  let index = html.indexOf(END_TAG, from)
  while (index !== -1) {
    const candidate = html.slice(index + END_TAG.length, index + END_TAG.length + name.length)
    if (candidate.toLowerCase() === name && isNameEnd(html[index + END_TAG.length + name.length])) {
      return index
    }
    index = html.indexOf(END_TAG, index + END_TAG.length)
  }
  return html.length
}

/**
 * Whether the element's own markup hides it: `hidden`, `aria-hidden="true"`,
 * or an inline `display: none` / `visibility: hidden`. What a stylesheet
 * hides, or places off screen, is not seen here and reaches the model.
 */
function isHidden(attributes: ReadonlyMap<string, string>): boolean {
  if (attributes.has('hidden') || attributes.get('aria-hidden')?.toLowerCase() === ARIA_HIDDEN) {
    return true
  }
  const style = attributes.get('style')
  if (style === undefined) {
    return false
  }
  const declarations = collapse(style).replaceAll(' ', '').toLowerCase()
  return HIDING_STYLES.some((hiding) => declarations.includes(hiding))
}

/** The language a `class` names (`language-ts`, `lang-py`), for a code fence. */
function languageOf(attributes: ReadonlyMap<string, string>): string | undefined {
  const names = (attributes.get('class') ?? '').split(' ')
  for (const name of names) {
    const prefix = LANGUAGE_CLASS.find((candidate) => name.startsWith(candidate))
    if (prefix !== undefined && name.length > prefix.length) {
      return name.slice(prefix.length)
    }
  }
  return undefined
}

interface OpenInline {
  readonly tag: string
  /** Where its text starts in the paragraph's parts. */
  readonly mark: number
  readonly wrap: (inner: string) => string
}

/**
 * The paragraph being written, as parts: closing an inline element joins
 * only the parts inside it, so a long paragraph is never copied whole for
 * each `<b>` in it, and the open elements are capped (MAX_INLINE_DEPTH), so
 * the work stays linear in the page.
 */
class InlineText {
  private parts: string[] = []
  /** The characters in the paragraph now, for the output bound. */
  public length = 0

  public get mark(): number {
    return this.parts.length
  }

  public append(text: string): void {
    if (text === '') {
      return
    }

    this.parts.push(text)
    this.length += text.length
  }

  public lastChar(): string | undefined {
    return this.parts.at(-1)?.at(-1)
  }

  /** Everything after `mark`, replaced by its wrapped form (left as is when blank). */
  public wrapFrom(mark: number, wrap: (inner: string) => string): void {
    const inner = this.parts.splice(mark).join('')
    this.length -= inner.length
    this.append(inner.trim() === '' ? inner : wrap(inner))
  }

  /** The text so far, and an empty paragraph after it. */
  public take(): string {
    const text = this.parts.join('')
    this.parts = []
    this.length = 0
    return text
  }
}

interface ListState {
  readonly isOrdered: boolean
  next: number
}

interface TableState {
  readonly rows: string[][]
  row: string[] | undefined
  isInCell: boolean
  caption: string | undefined
  isInCaption: boolean
}

/** The renderer: tokens in, Markdown blocks out. */
class MarkdownWriter {
  private readonly blocks: string[] = []
  private lastWasListItem = false
  private readonly inline = new InlineText()
  private readonly openInline: OpenInline[] = []
  private readonly lists: ListState[] = []
  /** The marker the next block starts with, inside a list item. */
  private itemMarker: string | undefined
  private quoteDepth = 0
  private heading: number | undefined
  private pre: { text: string; language: string | undefined; depth: number } | undefined
  private table: TableState | undefined
  private tableDepth = 0
  /** Characters written so far in blocks, and in the open table's cells. */
  private written = 0
  private tableChars = 0
  public title: string | undefined

  public constructor(
    private readonly base: URL,
    /** Past this many characters the conversion stops: the model reads fewer. */
    private readonly maxChars: number,
  ) {}

  /** The prefix of every line of a block: the quote marks, then the list indent. */
  private linePrefixes(): { first: string; rest: string } {
    // Capped, so a page nested thousands deep cannot square the output's size.
    const quote = QUOTE_PREFIX.repeat(Math.min(this.quoteDepth, MAX_PREFIX_DEPTH))
    if (this.lists.length === 0) {
      return { first: quote, rest: quote }
    }
    const indent = LIST_INDENT.repeat(Math.min(this.lists.length - 1, MAX_PREFIX_DEPTH))
    const marker = this.itemMarker ?? ''
    const hang = ' '.repeat(this.itemMarker === undefined ? LIST_INDENT.length : marker.length)
    return { first: `${quote}${indent}${marker}`, rest: `${quote}${indent}${hang}` }
  }

  /**
   * A block, each line prefixed. Only as much of the text as the bound still
   * allows is written, so a block of many short lines cannot multiply its
   * size by its prefixes.
   */
  private emit(text: string): void {
    const budget = this.maxChars - this.written
    if (budget <= 0) {
      return
    }
    const { first, rest } = this.linePrefixes()
    const lines: string[] = []
    let size = 0
    for (const line of text.slice(0, budget).split(LINE)) {
      const prefixed = `${lines.length === 0 ? first : rest}${line}`
      lines.push(prefixed)
      size += prefixed.length + LINE.length
      if (size > budget) {
        break
      }
    }
    const block = lines.join(LINE)
    const isListItem = this.lists.length > 0
    // Items of one list follow each other on the next line; other blocks
    // are a paragraph apart.
    let separator = isListItem && this.lastWasListItem ? LINE : PARAGRAPH
    if (this.blocks.length === 0) {
      separator = ''
    }
    this.blocks.push(`${separator}${block}`)
    this.written += separator.length + block.length
    this.lastWasListItem = isListItem
    this.itemMarker = undefined
  }

  /** Ends the paragraph being written: its text becomes a block. */
  private flush(): void {
    this.closeInline(0)
    const text = this.inline
      .take()
      .split(LINE)
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .join(LINE)
    if (this.table?.isInCell === true || this.table?.isInCaption === true) {
      // A block inside a cell stays in the cell, a space after it.
      this.inline.append(text === '' ? '' : `${text} `)
      return
    }
    if (text === '') {
      return
    }
    this.emit(
      this.heading === undefined
        ? text
        : `${'#'.repeat(this.heading)} ${text.split(LINE).join(' ')}`,
    )
  }

  private resolve(href: string | undefined, schemes: ReadonlySet<string>): string | undefined {
    if (href === undefined || href.trim() === '') {
      return undefined
    }
    let url: URL
    try {
      url = new URL(href.trim(), this.base)
    } catch {
      return undefined
    }
    if (!schemes.has(url.protocol)) {
      return undefined
    }
    // A link to a place on this same page says nothing a reader can follow.
    const page = new URL(this.base.href)
    page.hash = ''
    const target = new URL(url.href)
    target.hash = ''
    return url.hash !== '' && target.href === page.href ? undefined : url.href
  }

  /** An inline element's marks around its text; past MAX_INLINE_DEPTH it is plain text. */
  private open(tag: string, wrap: (inner: string) => string): void {
    if (this.openInline.length < MAX_INLINE_DEPTH) {
      this.openInline.push({ tag, mark: this.inline.mark, wrap })
    }
  }

  /** Closes the open inline elements from `index` up, innermost first. */
  private closeInline(index: number): void {
    for (let entry = this.openInline.pop(); entry !== undefined; entry = this.openInline.pop()) {
      this.inline.wrapFrom(entry.mark, entry.wrap)
      if (this.openInline.length <= index) {
        return
      }
    }
  }

  private closeInlineTag(tag: string): void {
    const index = this.openInline.findLastIndex((entry) => entry.tag === tag)
    if (index !== -1) {
      this.closeInline(index)
    }
  }

  private startBlock(): void {
    this.flush()
    this.heading = undefined
  }

  private startItem(): void {
    this.startBlock()
    const list = this.lists.at(-1)
    if (list === undefined) {
      return
    }
    this.itemMarker = list.isOrdered ? `${String(list.next)}. ` : BULLET
    list.next += 1
  }

  private startPre(attributes: ReadonlyMap<string, string>): void {
    if (this.pre !== undefined) {
      this.pre.depth += 1
      return
    }
    this.startBlock()
    this.pre = { text: '', language: languageOf(attributes), depth: 1 }
  }

  private endPre(): void {
    const { pre } = this
    if (pre === undefined) {
      return
    }
    pre.depth -= 1
    if (pre.depth > 0) {
      return
    }
    this.pre = undefined
    // HTML drops a line break right after `<pre>`.
    const code = (pre.text.startsWith(LINE) ? pre.text.slice(1) : pre.text).trimEnd()
    if (code === '') {
      return
    }
    if (this.table?.isInCell === true) {
      this.inline.append(inlineCode(collapse(code)))
      return
    }
    const fence = BACKTICK.repeat(Math.max(FENCE_MIN, longestBacktickRun(code) + 1))
    this.emit(`${fence}${pre.language ?? ''}${LINE}${code}${LINE}${fence}`)
  }

  private startTable(): void {
    this.tableDepth += 1
    if (this.tableDepth > 1) {
      this.inline.append(' ')
      return
    }
    this.startBlock()
    this.table = {
      rows: [],
      row: undefined,
      isInCell: false,
      caption: undefined,
      isInCaption: false,
    }
  }

  private endCell(): void {
    const { table } = this
    if (!table?.isInCell) {
      return
    }
    this.flush()
    table.isInCell = false
    // A row is one line: a line break in a cell becomes a space, a pipe is escaped.
    const cell = this.inline.take().trim().split(LINE).join(' ').split(PIPE).join(ESCAPED_PIPE)
    table.row ??= []
    table.row.push(cell)
    this.tableChars += cell.length + CELL_SEPARATOR.length
  }

  private endRow(): void {
    this.endCell()
    const { table } = this
    if (table?.row === undefined) {
      return
    }

    table.rows.push(table.row)
    table.row = undefined
  }

  private endCaption(): void {
    const { table } = this
    if (table?.isInCaption !== true) {
      return
    }
    this.flush()
    table.isInCaption = false
    table.caption = this.inline.take().trim()
  }

  private endTable(): void {
    this.tableDepth = Math.max(this.tableDepth - 1, 0)
    if (this.tableDepth > 0) {
      this.inline.append(' ')
      return
    }
    this.endCaption()
    this.endRow()
    const { table } = this
    this.table = undefined
    if (table === undefined) {
      return
    }
    if (table.caption !== undefined && table.caption !== '') {
      this.emit(table.caption)
    }
    this.tableChars = 0
    let widest = 0
    for (const row of table.rows) {
      widest = Math.max(widest, row.length)
    }
    // The width is capped: the cells past the cap share the last column.
    const width = Math.min(widest, MAX_TABLE_COLUMNS)
    if (width === 0) {
      return
    }
    // Only the header and its rule are padded to the width (GFM reads a
    // shorter body row as empty cells), so a row costs what it holds.
    const line = (cells: readonly string[], columns: number) => {
      const kept = cells.slice(0, width - 1)
      const rest = cells.slice(width - 1)
      const shown = rest.length === 0 ? kept : [...kept, rest.join(' ')]
      const padded = Array.from({ length: columns }, (_, index) => shown[index] ?? '')
      return `${PIPE} ${padded.join(CELL_SEPARATOR)} ${PIPE}`
    }
    const [header = [], ...body] = table.rows
    const separator = line(
      Array.from({ length: width }, () => RULE),
      width,
    )
    this.emit(
      [
        line(header, width),
        separator,
        ...body.map((row) => line(row, Math.min(row.length, width))),
      ].join(LINE),
    )
  }

  private tableTag(name: string, isEnd: boolean): boolean {
    const { table } = this
    if (table === undefined || this.tableDepth > 1) {
      if (this.tableDepth > 1 && (name === 'tr' || CELLS.has(name))) {
        this.inline.append(' ')
        return true
      }
      return false
    }
    if (name === 'tr') {
      this.endRow()
      return true
    }
    if (CELLS.has(name)) {
      this.endCell()
      if (!isEnd) {
        table.isInCell = true
      }
      return true
    }
    if (name === 'caption') {
      if (isEnd) {
        this.endCaption()
      } else {
        table.isInCaption = true
      }
      return true
    }
    return false
  }

  private image(attributes: ReadonlyMap<string, string>): void {
    const alt = collapse(attributes.get('alt') ?? '').trim()
    const source = this.resolve(attributes.get('src'), IMAGE_SCHEMES)
    // An image without words says nothing to a reader; a data: image is bytes.
    if (alt !== '' && source !== undefined) {
      this.inline.append(`![${alt}](${source})`)
    }
  }

  /** A tag that shapes blocks: lists, quotes, code blocks, breaks, rules, images. */
  private startStructure(name: string, attributes: ReadonlyMap<string, string>): void {
    if (LISTS.has(name)) {
      this.startBlock()
      const start = Number(attributes.get('start') ?? 1)
      this.lists.push({ isOrdered: name === 'ol', next: Number.isSafeInteger(start) ? start : 1 })
      return
    }
    switch (name) {
      case 'li': {
        this.startItem()
        break
      }
      case 'blockquote': {
        this.startBlock()
        this.quoteDepth += 1
        break
      }
      case 'pre': {
        this.startPre(attributes)
        break
      }
      case 'br': {
        this.inline.append(LINE)
        break
      }
      case 'hr': {
        this.startBlock()
        this.emit(RULE)
        break
      }
      case 'img': {
        this.image(attributes)
        break
      }
      default: {
        if (BLOCKS.has(name)) {
          this.startBlock()
        }
      }
    }
  }

  /** A tag inside a code block: only a nested block, a break and a language count. */
  private preTag(name: string, attributes: ReadonlyMap<string, string>): void {
    const { pre } = this
    if (pre === undefined) {
      return
    }
    switch (name) {
      case 'pre': {
        this.startPre(attributes)
        break
      }
      case 'br': {
        pre.text += LINE
        break
      }
      case 'code': {
        pre.language ??= languageOf(attributes)
        break
      }
      // Any other markup inside a code block is not part of its text.
    }
  }

  /** Whether the output has reached its bound; nothing more is converted then. */
  public get isFull(): boolean {
    const pending = this.inline.length + this.tableChars + (this.pre?.text.length ?? 0)
    return this.written + pending > this.maxChars
  }

  public text(raw: string): void {
    if (this.pre !== undefined) {
      this.pre.text += decodeHTML(raw)
      return
    }
    if (this.table !== undefined && !this.table.isInCell && !this.table.isInCaption) {
      return
    }
    const text = collapse(decodeHTML(raw))
    const isAtBreak = [undefined, ' ', LINE].includes(this.inline.lastChar())
    this.inline.append(isAtBreak && text.startsWith(' ') ? text.slice(1) : text)
  }

  public startTag(name: string, attributes: ReadonlyMap<string, string>): void {
    if (this.pre !== undefined) {
      this.preTag(name, attributes)
      return
    }
    if (name === 'table') {
      this.startTable()
      return
    }
    if (this.tableTag(name, false)) {
      return
    }
    const level = HEADINGS.get(name)
    const marker = MARKERS.get(name)
    if (level !== undefined) {
      this.startBlock()
      this.heading = level
    } else if (marker !== undefined) {
      this.open(name, (inner) => around(inner, marker))
    } else if (CODE.has(name)) {
      this.open(name, (inner) => inlineCode(inner.trim()))
    } else if (name === 'a') {
      const href = this.resolve(attributes.get('href'), LINK_SCHEMES)
      this.open(name, (inner) => (href === undefined ? inner : `[${inner.trim()}](${href})`))
    } else {
      this.startStructure(name, attributes)
    }
  }

  public endTag(name: string): void {
    if (this.pre !== undefined) {
      if (name === 'pre') {
        this.endPre()
      }
      return
    }
    if (name === 'table') {
      this.endTable()
      return
    }
    if (this.tableTag(name, true)) {
      return
    }
    if (HEADINGS.has(name)) {
      this.flush()
      this.heading = undefined
    } else if (LISTS.has(name)) {
      this.flush()
      this.lists.pop()
      // The next list or paragraph is a block of its own, not another item.
      if (this.lists.length === 0) {
        this.lastWasListItem = false
      }
    } else if (name === 'blockquote') {
      this.flush()
      this.quoteDepth = Math.max(this.quoteDepth - 1, 0)
    } else if (name === 'a' || MARKERS.has(name) || CODE.has(name)) {
      this.closeInlineTag(name)
    } else if (name === 'li' || BLOCKS.has(name)) {
      this.flush()
    }
  }

  public finish(): string {
    if (this.pre !== undefined) {
      this.pre.depth = 1
      this.endPre()
    }
    if (this.table !== undefined) {
      this.tableDepth = 1
      this.endTable()
    }
    this.flush()
    return this.blocks
      .join('')
      .replaceAll(EXCESS_BREAKS, () => PARAGRAPH)
      .trim()
  }
}

/** Where a markup construct that is not a tag (a comment, a doctype, CDATA) ends. */
function skipMarkup(html: string, start: number): number {
  if (html.startsWith(COMMENT_OPEN, start)) {
    const end = html.indexOf(COMMENT_CLOSE, start + COMMENT_OPEN.length)
    return end === -1 ? html.length : end + COMMENT_CLOSE.length
  }
  if (html.startsWith(CDATA_OPEN, start)) {
    const end = html.indexOf(CDATA_CLOSE, start + CDATA_OPEN.length)
    return end === -1 ? html.length : end + CDATA_CLOSE.length
  }
  const end = html.indexOf(TAG_CLOSE, start)
  return end === -1 ? html.length : end + 1
}

/**
 * Open elements by name. Membership and barriers are counted, so neither a
 * check nor a close walks a hostile page's nesting: each element is pushed
 * and popped once.
 */
class OpenElements {
  private readonly names: string[] = []
  private readonly counts = new Map<string, number>()
  private barrierCount = 0

  public constructor(private readonly barriers: ReadonlySet<string> = NOTHING) {}

  public get top(): string | undefined {
    return this.names.at(-1)
  }

  /** Whether an element that keeps the enclosing one open is open here. */
  public get hasBarrier(): boolean {
    return this.barrierCount > 0
  }

  public has(name: string): boolean {
    return (this.counts.get(name) ?? 0) > 0
  }

  public push(name: string): void {
    this.names.push(name)
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1)
    if (this.barriers.has(name)) {
      this.barrierCount += 1
    }
  }

  public pop(): void {
    const name = this.names.pop()
    if (name === undefined) {
      return
    }
    this.counts.set(name, (this.counts.get(name) ?? 1) - 1)
    if (this.barriers.has(name)) {
      this.barrierCount -= 1
    }
  }

  /** Closes the innermost `name` and all opened inside it; false when none is open. */
  public closeTo(name: string): boolean {
    if (!this.has(name)) {
      return false
    }
    while (this.top !== name) {
      this.pop()
    }
    this.pop()
    return true
  }

  /** Closes the elements on top that a new `name` start tag ends without their end tags. */
  public closeImplied(name: string): void {
    for (let top = this.top; top !== undefined; top = this.top) {
      if (IMPLIED_ENDS.get(top)?.closedBy.has(name) !== true) {
        return
      }
      this.pop()
    }
  }
}

/**
 * A hidden or skipped subtree being passed over: its root, what is open
 * inside it, and, for an element a page may leave open, what ends it.
 */
interface Skip {
  readonly root: string
  readonly isHidden: boolean
  readonly inner: OpenElements
  readonly implied: ImpliedEnd | undefined
}

/**
 * What a tag does to a skip: stays inside it, closes its root (`closed`),
 * or ends it and is then read as usual (`after`): a start tag that closes
 * an element a page may leave open, or the end tag of an element open
 * around the hidden one, which closes it too.
 */
function skipStep(skip: Skip, tag: Tag, open: OpenElements): 'inside' | 'closed' | 'after' {
  if (!tag.isEnd) {
    if (skip.implied?.closedBy.has(tag.name) === true && !skip.inner.hasBarrier) {
      return 'after'
    }
    if (!VOID.has(tag.name)) {
      skip.inner.push(tag.name)
    }
    return 'inside'
  }
  if (skip.inner.closeTo(tag.name)) {
    return 'inside'
  }
  if (tag.name === skip.root) {
    return 'closed'
  }
  return skip.isHidden && open.has(tag.name) ? 'after' : 'inside'
}

/**
 * Whether the element is hidden: by its own markup, or by what browsers
 * never show (a dialog not opened, ruby's fallback parentheses).
 */
function isHiddenElement(tag: Tag): boolean {
  return (
    (tag.name === 'dialog' && !tag.attributes.has('open')) ||
    tag.name === 'rp' ||
    isHidden(tag.attributes)
  )
}

/**
 * A container whose content is left out: skipped by kind, or hidden. A
 * self-closing slash means nothing on an HTML element, so a hidden one
 * still hides what follows up to its end.
 */
function skipOf(tag: Tag): Skip | undefined {
  if (tag.isEnd || VOID.has(tag.name)) {
    return undefined
  }
  const isSkipped = SKIPPED.has(tag.name) && !tag.isSelfClosing
  const isHiddenRoot = !SKIPPED.has(tag.name) && isHiddenElement(tag)
  if (!isSkipped && !isHiddenRoot) {
    return undefined
  }
  const implied = IMPLIED_ENDS.get(tag.name)
  return {
    root: tag.name,
    isHidden: isHiddenRoot,
    inner: new OpenElements(implied?.barriers),
    implied,
  }
}

/**
 * The page as Markdown; links and images made absolute against `base`. The
 * conversion stops once the Markdown passes `maxChars` (a hostile page can
 * expand, a relative link into a long absolute one), and says so.
 */
export function htmlToMarkdown(html: string, base: URL, maxChars: number): MarkdownPage {
  const writer = new MarkdownWriter(base, maxChars)
  // What is open around the text being read, for an end tag that closes a
  // hidden element too.
  const open = new OpenElements()
  let skip: Skip | undefined
  let index = 0
  while (index < html.length && !writer.isFull) {
    const lt = html.indexOf(TAG_OPEN, index)
    const textEnd = lt === -1 ? html.length : lt
    if (skip === undefined && textEnd > index) {
      writer.text(html.slice(index, textEnd))
    }
    if (lt === -1) {
      break
    }
    const next = html[lt + 1]
    if (next === '!' || next === '?') {
      index = skipMarkup(html, lt)
      continue
    }
    const tag = readTag(html, lt)
    if (tag === undefined) {
      if (skip === undefined) {
        writer.text(TAG_OPEN)
      }
      index = lt + 1
      continue
    }
    index = tag.next
    if (!tag.isEnd && RAW_TEXT.has(tag.name)) {
      const end = rawTextEnd(html, index, tag.name)
      if (skip === undefined && tag.name === 'title' && writer.title === undefined) {
        const title = html.slice(index, Math.min(end, index + MAX_TITLE_SOURCE_CHARS))
        writer.title = collapse(decodeHTML(title)).trim() || undefined
      }
      const close = html.indexOf(TAG_CLOSE, end)
      index = close === -1 || end >= html.length ? html.length : close + 1
      continue
    }
    if (skip !== undefined) {
      const step = skipStep(skip, tag, open)
      if (step !== 'inside') {
        skip = undefined
      }
      if (step !== 'after') {
        continue
      }
    }
    // A hidden image says nothing, not even its text alternative.
    if (!tag.isEnd && VOID.has(tag.name) && isHiddenElement(tag)) {
      continue
    }
    if (!tag.isEnd) {
      open.closeImplied(tag.name)
    }
    skip = skipOf(tag)
    if (skip !== undefined) {
      continue
    }
    if (tag.isEnd) {
      open.closeTo(tag.name)
      writer.endTag(tag.name)
    } else {
      writer.startTag(tag.name, tag.attributes)
      if (tag.isSelfClosing && !VOID.has(tag.name)) {
        writer.endTag(tag.name)
      } else if (!VOID.has(tag.name)) {
        open.push(tag.name)
      }
    }
  }
  const isTruncated = writer.isFull
  const markdown = writer.finish()
  return { title: writer.title, markdown, isTruncated }
}
