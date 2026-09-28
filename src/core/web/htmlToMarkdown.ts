// A fetched HTML page as Markdown for the model to read (M69, PLAN.md D49):
// headings, paragraphs, lists, links, emphasis, code blocks, quotes and
// tables kept; scripts, styles, forms' controls, embedded media, SVG and
// MathML left out, and so is what HTML itself hides: the `hidden`, `inert`
// and `aria-hidden="true"` attributes, an inline style of `display: none`,
// `visibility: hidden` or `collapse`, or `content-visibility: hidden`
// (inlineStyle.ts), a dialog not opened, a template's content, `<noscript>`
// (a browser that runs scripts shows none of it) and ruby's fallback
// parentheses. A stylesheet's rules are not read: text a class hides still
// reaches the model, inside the markers that call the page untrusted.
//
// The page is parsed by parse5, which implements the HTML standard's
// parsing algorithm, so where each element ends (implied ends, misnested
// and self-closed tags, SVG and MathML, comments, scripts) is decided as a
// browser decides it. Relative links resolve against the first `<base
// href>`, as the standard's document base URL does. This module runs on a
// worker thread (src/host/web/pageWorker.ts): parse5 takes time that grows
// faster than the page on a page nested to be hostile, and the worker is
// stopped at a time and memory limit. The walk over the tree is iterative
// and its output bounded, so a page built to expand stops at the bound.

import { type DefaultTreeAdapterTypes, defaultTreeAdapter, html as spec, parse } from 'parse5'
import { changedEncoding, charsetInMetaContent, decodeHtml } from './htmlCharset'
import type { HtmlJob, MarkdownPage } from './htmlConversion'
import { inlineVisibility } from './inlineStyle'
import { decodeIn, encodingOf } from './textDecoding'

type Element = DefaultTreeAdapterTypes.Element
type ChildNode = DefaultTreeAdapterTypes.ChildNode
type ParentNode = DefaultTreeAdapterTypes.ParentNode

// Elements whose content is left out: the head (its title is read on its
// own), code, media, controls, drawings, and what a browser that runs
// scripts never renders.
const OMITTED = new Set([
  'head',
  'title',
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'noembed',
  'noframes',
  'object',
  'embed',
  'canvas',
  'audio',
  'video',
  'picture',
  'select',
  'button',
  'textarea',
  'input',
  'datalist',
  'map',
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
const ARIA_HIDDEN = 'true'
// The elements a declarative shadow root may attach to (and any custom element).
const SHADOW_HOSTS = new Set([
  'article',
  'aside',
  'blockquote',
  'body',
  'div',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'main',
  'nav',
  'p',
  'section',
  'span',
])
const SHADOW_ROOT_MODES = new Set(['open', 'closed'])
const CONTENT_TYPE = 'content-type'
// Base URLs a page may not set (the standard's document base URL rule).
const REFUSED_BASE_SCHEMES = new Set(['data:', 'javascript:'])

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
const LINE = '\n'
const PARAGRAPH = '\n\n'
const EXCESS_BREAKS = /\n{3,}/g

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
      this.pre.text += raw
      return
    }
    if (this.table !== undefined && !this.table.isInCell && !this.table.isInCaption) {
      return
    }
    const text = collapse(raw)
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

function isElement(node: ChildNode): node is Element {
  return 'tagName' in node
}

function attributeOf(element: Element, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name === name)?.value
}

/** The element's attributes by name (parse5 keeps the first of a name, as HTML does). */
function attributesOf(element: Element): ReadonlyMap<string, string> {
  return new Map(element.attrs.map((attribute) => [attribute.name, attribute.value]))
}

/**
 * Whether HTML hides the element and all it holds: its `hidden`, `inert`,
 * `popover` (until shown) or `aria-hidden="true"` attribute, a dialog not
 * opened, or ruby's fallback parentheses (`rp`). Its inline style is read in
 * the walk, where `visibility` passes down to what it holds.
 */
function isHiddenElement(element: Element): boolean {
  const attributes = attributesOf(element)
  return (
    attributes.has('hidden') ||
    attributes.has('inert') ||
    attributes.has('popover') ||
    attributes.get('aria-hidden')?.trim().toLowerCase() === ARIA_HIDDEN ||
    (element.tagName === 'dialog' && !attributes.has('open')) ||
    element.tagName === 'rp'
  )
}

/** Whether the element and its content are left out of the Markdown. */
function isLeftOut(element: Element): boolean {
  return (
    element.namespaceURI !== spec.NS.HTML ||
    OMITTED.has(element.tagName) ||
    isHiddenElement(element)
  )
}

/** Every node of the tree in document order, without recursion (a page may nest deep). */
function* inTreeOrder(root: ParentNode): Generator<ChildNode> {
  const pending: ChildNode[] = root.childNodes.toReversed()
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    yield node
    if (isElement(node)) {
      for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
        const child = node.childNodes[index]
        if (child !== undefined) {
          pending.push(child)
        }
      }
    }
  }
}

function isHtml(node: ChildNode, name: string): node is Element {
  return isElement(node) && node.namespaceURI === spec.NS.HTML && node.tagName === name
}

/**
 * The document's base URL: the first `<base href>` in tree order, resolved
 * against the page's URL; the page's URL when there is none, when it does
 * not parse, or when it names a `data:` or `javascript:` URL.
 */
function baseOf(document: ParentNode, pageUrl: URL): URL {
  for (const node of inTreeOrder(document)) {
    const href = isHtml(node, 'base') ? attributeOf(node, 'href') : undefined
    if (href === undefined) {
      continue
    }
    try {
      const base = new URL(href, pageUrl)
      return REFUSED_BASE_SCHEMES.has(base.protocol) ? pageUrl : base
    } catch {
      return pageUrl
    }
  }
  return pageUrl
}

/** The first child of `parent` that is the HTML element `name`. */
function childNamed(parent: ParentNode | undefined, name: string): Element | undefined {
  return parent?.childNodes.find((node): node is Element => isHtml(node, name))
}

/**
 * The page's title: the first `<title>` that is a child of `<head>`, white
 * space collapsed. (The standard's document.title takes the first anywhere;
 * one the parser put inside a hidden element must not reach the model.)
 */
function titleOf(document: ParentNode): string | undefined {
  const title = childNamed(childNamed(childNamed(document, 'html'), 'head'), 'title')
  if (title === undefined) {
    return undefined
  }
  const text = title.childNodes
    .map((child) => (defaultTreeAdapter.isTextNode(child) ? child.value : ''))
    .join('')
  return collapse(text.slice(0, MAX_TITLE_SOURCE_CHARS)).trim() || undefined
}

/**
 * A shadow tree being written (declarative shadow DOM): the host's children
 * by the slot they go to (`''` for the default slot), the slots already
 * filled (only the first of a name takes them), and the tree around the
 * host, which those children belong to.
 */
interface ShadowScope {
  readonly slots: ReadonlyMap<string, readonly ChildNode[]>
  readonly filled: Set<string>
  readonly outer: ShadowScope | undefined
}

/** One step of the walk: a node to enter in its tree, or an element whose content is done. */
/** Where a node is: the shadow tree it is in, and whether what it inherits shows (`visibility`). */
interface Place {
  readonly scope: ShadowScope | undefined
  readonly isVisible: boolean
}

type Step = { readonly enter: ChildNode; readonly place: Place } | { readonly leave: string }

/** The template that gives the host a declarative shadow root: its first child `<template shadowrootmode>`. */
function shadowTemplateOf(host: Element): DefaultTreeAdapterTypes.Template | undefined {
  if (!SHADOW_HOSTS.has(host.tagName) && !host.tagName.includes('-')) {
    return undefined
  }
  for (const child of host.childNodes) {
    if (
      isHtml(child, 'template') &&
      SHADOW_ROOT_MODES.has(attributeOf(child, 'shadowrootmode')?.toLowerCase() ?? '')
    ) {
      return child as DefaultTreeAdapterTypes.Template
    }
  }
  return undefined
}

/** The host's children by the slot each goes to; the shadow root's template is not one of them. */
function slotsOf(host: Element, template: Element): ReadonlyMap<string, readonly ChildNode[]> {
  const slots = new Map<string, ChildNode[]>()
  for (const child of host.childNodes) {
    if (child === template || !(isElement(child) || defaultTreeAdapter.isTextNode(child))) {
      continue
    }
    const name = isElement(child) ? (attributeOf(child, 'slot') ?? '') : ''
    slots.set(name, [...(slots.get(name) ?? []), child])
  }
  return slots
}

/** Pushes nodes to enter, first on top. */
function pushAll(steps: Step[], nodes: readonly ChildNode[], place: Place): void {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (node !== undefined) {
      steps.push({ enter: node, place })
    }
  }
}

/**
 * What an element shows of its content: a shadow root's in place of its own
 * children, a filled slot's assigned nodes (else its own, as fallback), and
 * of a closed `<details>` only its summary.
 */
function pushContent(steps: Step[], element: Element, place: Place): void {
  const template = shadowTemplateOf(element)
  if (template !== undefined) {
    const shadow: ShadowScope = {
      slots: slotsOf(element, template),
      filled: new Set(),
      outer: place.scope,
    }
    pushAll(steps, defaultTreeAdapter.getTemplateContent(template).childNodes, {
      scope: shadow,
      isVisible: place.isVisible,
    })
    return
  }
  if (element.tagName === 'details' && attributeOf(element, 'open') === undefined) {
    const summary = element.childNodes.find((child) => isHtml(child, 'summary'))
    pushAll(steps, summary === undefined ? [] : [summary], place)
    return
  }
  pushAll(steps, element.childNodes, place)
}

/**
 * A `<slot>` in a shadow tree: the nodes assigned to it, or its own as
 * fallback; they inherit where the slot is, as the flattened tree does.
 */
function pushSlot(
  steps: Step[],
  slot: Element,
  place: Place & { readonly scope: ShadowScope },
): void {
  const { scope } = place
  const name = attributeOf(slot, 'name') ?? ''
  const assigned = scope.filled.has(name) ? undefined : scope.slots.get(name)
  scope.filled.add(name)
  if (assigned !== undefined && assigned.length > 0) {
    pushAll(steps, assigned, { scope: scope.outer, isVisible: place.isVisible })
    return
  }
  pushAll(steps, slot.childNodes, place)
}

/**
 * Writes what is shown of the tree, in document order, until the writer is
 * full. An element its inline style leaves out (`display: none`,
 * `content-visibility: hidden`) takes all it holds with it; one whose
 * `visibility` hides it writes no text of its own, but a descendant that
 * sets `visibility: visible` still shows, in its place.
 */
function writeShown(document: ParentNode, writer: MarkdownWriter): void {
  const steps: Step[] = []
  pushAll(steps, document.childNodes, { scope: undefined, isVisible: true })
  for (let step = steps.pop(); step !== undefined && !writer.isFull; step = steps.pop()) {
    if ('leave' in step) {
      writer.endTag(step.leave)
      continue
    }
    const { enter: node, place } = step
    if (!isElement(node)) {
      if (place.isVisible && defaultTreeAdapter.isTextNode(node)) {
        writer.text(node.value)
      }
      continue
    }
    const style = attributeOf(node, 'style')
    const inline = style === undefined ? undefined : inlineVisibility(style)
    if (isLeftOut(node) || inline?.isDiscarded === true) {
      continue
    }
    const own: Place = {
      scope: place.scope,
      isVisible:
        inline?.visibility === undefined ? place.isVisible : inline.visibility === 'visible',
    }
    if (own.scope !== undefined && isHtml(node, 'slot')) {
      pushSlot(steps, node, { scope: own.scope, isVisible: own.isVisible })
      continue
    }
    // Hidden by visibility: its tags stay, so a descendant shown again keeps
    // its list or table, but its text and its void elements (an image's
    // alternative) are not written; an empty element writes nothing.
    if (!own.isVisible && VOID.has(node.tagName)) {
      continue
    }
    writer.startTag(node.tagName, attributesOf(node))
    if (VOID.has(node.tagName)) {
      continue
    }
    steps.push({ leave: node.tagName })
    pushContent(steps, node, own)
  }
}

/** The page as Markdown from its tree, links resolved against its base URL. */
function pageOf(document: ParentNode, pageUrl: URL, maxChars: number): MarkdownPage {
  const writer = new MarkdownWriter(baseOf(document, pageUrl), maxChars)
  writeShown(document, writer)
  const isTruncated = writer.isFull
  return { title: titleOf(document), markdown: writer.finish(), isTruncated }
}

/**
 * The page as Markdown; links and images made absolute against its base
 * URL. The conversion stops once the Markdown passes `maxChars` (a hostile
 * page can expand, a relative link into a long absolute one), and says so.
 */
export function htmlToMarkdown(html: string, pageUrl: URL, maxChars: number): MarkdownPage {
  return pageOf(parse(html), pageUrl, maxChars)
}

/**
 * The encoding the first `<meta>` in the tree declares (its `charset`, or
 * an `http-equiv="content-type"` content's charset), as the parser meets it.
 */
function declaredEncodingOf(document: ParentNode): string | undefined {
  for (const node of inTreeOrder(document)) {
    if (!isHtml(node, 'meta')) {
      continue
    }
    const httpEquiv = attributeOf(node, 'http-equiv')?.trim().toLowerCase()
    const content = attributeOf(node, 'content')
    const label =
      attributeOf(node, 'charset') ??
      (httpEquiv === CONTENT_TYPE && content !== undefined
        ? charsetInMetaContent(content)
        : undefined)
    if (label !== undefined && encodingOf(label) !== undefined) {
      return label
    }
  }
  return undefined
}

/**
 * One fetched page, from its bytes: decoded as HTML decodes it, then
 * converted. When the encoding was only tentative and a `<meta>` the parser
 * meets declares another, the page is read again in that one, as a browser
 * reparses it.
 */
export function convertHtmlJob(job: HtmlJob): MarkdownPage {
  const decoded = decodeHtml(job.bytes, job.charset)
  let document = parse(decoded.text)
  if (decoded.isTentative) {
    const declared = declaredEncodingOf(document)
    const next = declared === undefined ? undefined : changedEncoding(decoded.encoding, declared)
    if (next !== undefined) {
      document = parse(decodeIn(job.bytes, next))
    }
  }
  return pageOf(document, new URL(job.url), job.maxChars)
}
