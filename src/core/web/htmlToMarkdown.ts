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
// What the converter follows of HTML's tree construction (the WHATWG parsing
// algorithm), as far as it decides what is hidden or left out: which
// elements are open, what closes them without an end tag, and which end
// tags are ignored. Every set below is named as the algorithm names it.

const HEADING_NAMES = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']
const HEADING_SET: ReadonlySet<string> = new Set(HEADING_NAMES)
// "Has an element in scope": open above the element, these hide it.
const DEFAULT_SCOPE: ReadonlySet<string> = new Set([
  'applet',
  'caption',
  'html',
  'marquee',
  'object',
  'table',
  'td',
  'template',
  'th',
])
const BUTTON_SCOPE: ReadonlySet<string> = new Set([...DEFAULT_SCOPE, 'button'])
const LIST_ITEM_SCOPE: ReadonlySet<string> = new Set([...DEFAULT_SCOPE, 'ol', 'ul'])
const TABLE_SCOPE: ReadonlySet<string> = new Set(['html', 'table', 'template'])
// Inside these a table is not restarted by another `<table>`.
const TABLE_RESTART_BARRIERS: ReadonlySet<string> = new Set(['caption', 'td', 'th', 'template'])
// The "special" category: an end tag that is not one of the listed ones
// closes nothing past these; a list item's search stops at them but for
// address, div and p.
const SPECIAL: ReadonlySet<string> = new Set([
  'address',
  'applet',
  'area',
  'article',
  'aside',
  'base',
  'basefont',
  'bgsound',
  'blockquote',
  'body',
  'br',
  'button',
  'caption',
  'center',
  'col',
  'colgroup',
  'dd',
  'details',
  'dir',
  'div',
  'dl',
  'dt',
  'embed',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'frame',
  'frameset',
  ...HEADING_NAMES,
  'head',
  'header',
  'hgroup',
  'hr',
  'html',
  'iframe',
  'img',
  'input',
  'keygen',
  'li',
  'link',
  'listing',
  'main',
  'marquee',
  'menu',
  'meta',
  'nav',
  'noembed',
  'noframes',
  'noscript',
  'object',
  'ol',
  'p',
  'param',
  'plaintext',
  'pre',
  'script',
  'search',
  'section',
  'select',
  'source',
  'style',
  'summary',
  'table',
  'tbody',
  'td',
  'template',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'title',
  'tr',
  'track',
  'ul',
  'wbr',
  'xmp',
])
const LIST_SCOPE: ReadonlySet<string> = new Set(
  [...SPECIAL].filter((name) => name !== 'address' && name !== 'div' && name !== 'p'),
)
// What "generate implied end tags" closes: ruby's parts close only through these.
const GENERATED_ENDS: ReadonlySet<string> = new Set([
  'dd',
  'dt',
  'li',
  'optgroup',
  'option',
  'p',
  'rb',
  'rp',
  'rt',
  'rtc',
])
// Elements whose closing clears the formatting elements opened inside them.
const FORMATTING_MARKERS: ReadonlySet<string> = new Set([
  'applet',
  'caption',
  'marquee',
  'object',
  'td',
  'template',
  'th',
])
// Formatting elements: closed by the adoption agency, and reopened after an
// element around them closed, until their own end tag.
const FORMATTING: ReadonlySet<string> = new Set([
  'a',
  'b',
  'big',
  'code',
  'em',
  'font',
  'i',
  'nobr',
  's',
  'small',
  'strike',
  'strong',
  'tt',
  'u',
])
// End tags that close an element in scope; any other name closes nothing
// past a special element.
const SCOPED_ENDS: ReadonlySet<string> = new Set([
  'address',
  'applet',
  'article',
  'aside',
  'blockquote',
  'button',
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
  'header',
  'hgroup',
  'listing',
  'main',
  'marquee',
  'menu',
  'nav',
  'object',
  'ol',
  'pre',
  'search',
  'section',
  'summary',
  'ul',
])
const TABLE_ENDS: ReadonlySet<string> = new Set([
  'caption',
  'colgroup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
])
// Foreign content (SVG, MathML): its own rules until a breakout tag, except
// inside an integration point, where HTML's rules apply again.
const FOREIGN_ROOTS: ReadonlySet<string> = new Set(['svg', 'math'])
const INTEGRATION_POINTS: ReadonlySet<string> = new Set([
  'annotation-xml',
  'desc',
  'foreignobject',
  'mi',
  'mn',
  'mo',
  'ms',
  'mtext',
  'title',
])
const BREAKOUT: ReadonlySet<string> = new Set([
  'b',
  'big',
  'blockquote',
  'body',
  'br',
  'center',
  'code',
  'dd',
  'div',
  'dl',
  'dt',
  'em',
  'embed',
  ...HEADING_NAMES,
  'head',
  'hr',
  'i',
  'img',
  'li',
  'listing',
  'menu',
  'meta',
  'nobr',
  'ol',
  'p',
  'pre',
  'ruby',
  's',
  'small',
  'span',
  'strong',
  'strike',
  'sub',
  'sup',
  'table',
  'tt',
  'u',
  'ul',
  'var',
])
const FONT_BREAKOUT_ATTRIBUTES = ['color', 'face', 'size']
// The start tags that close an open `<p>` (a table does only outside quirks
// mode, so it is left out: a hidden paragraph then hides it too).
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
  ...HEADING_NAMES,
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
  'xmp',
])
const TABLE_SECTIONS = ['thead', 'tbody', 'tfoot']
const TABLE_CONTEXT_STARTS = ['caption', 'col', 'colgroup']

/**
 * What, open above an element, keeps a start tag from closing it: an
 * element of a scope's set, anything at all (it closes only as the current
 * node), or anything "generate implied end tags" would not close.
 */
type Barrier =
  | { readonly kind: 'set'; readonly names: ReadonlySet<string> }
  | { readonly kind: 'anything' }
  | { readonly kind: 'notGenerated' }

/** The start tags that close an element without its end tag, and what keeps it open. */
interface ImpliedEnd {
  readonly closedBy: ReadonlySet<string>
  readonly barrier: Barrier
}

const ANYTHING: Barrier = { kind: 'anything' }
const IN_TABLE: Barrier = { kind: 'set', names: TABLE_SCOPE }
const ITEM_END: ImpliedEnd = {
  closedBy: new Set(['li']),
  barrier: { kind: 'set', names: LIST_SCOPE },
}
const TERM_END: ImpliedEnd = {
  closedBy: new Set(['dt', 'dd']),
  barrier: { kind: 'set', names: LIST_SCOPE },
}
const CELL_END: ImpliedEnd = {
  closedBy: new Set(['td', 'th', 'tr', ...TABLE_SECTIONS, ...TABLE_CONTEXT_STARTS]),
  barrier: IN_TABLE,
}
const SECTION_END: ImpliedEnd = {
  closedBy: new Set([...TABLE_SECTIONS, ...TABLE_CONTEXT_STARTS]),
  barrier: IN_TABLE,
}
const RUBY_END: ImpliedEnd = {
  closedBy: new Set(['rb', 'rt', 'rp', 'rtc']),
  barrier: { kind: 'notGenerated' },
}
const HEADING_END: ImpliedEnd = { closedBy: HEADING_SET, barrier: ANYTHING }
const IMPLIED_ENDS: ReadonlyMap<string, ImpliedEnd> = new Map([
  ['p', { closedBy: PARAGRAPH_CLOSERS, barrier: { kind: 'set', names: BUTTON_SCOPE } }],
  ['li', ITEM_END],
  ['dt', TERM_END],
  ['dd', TERM_END],
  ['option', { closedBy: new Set(['option', 'optgroup', 'hr']), barrier: ANYTHING }],
  ['optgroup', { closedBy: new Set(['optgroup', 'hr']), barrier: ANYTHING }],
  [
    'tr',
    { closedBy: new Set(['tr', ...TABLE_SECTIONS, ...TABLE_CONTEXT_STARTS]), barrier: IN_TABLE },
  ],
  ['td', CELL_END],
  ['th', CELL_END],
  ['thead', SECTION_END],
  ['tbody', SECTION_END],
  ['tfoot', SECTION_END],
  [
    'caption',
    {
      closedBy: new Set(['caption', 'col', 'colgroup', 'tr', 'td', 'th', ...TABLE_SECTIONS]),
      barrier: IN_TABLE,
    },
  ],
  [
    'colgroup',
    {
      closedBy: new Set(['caption', 'colgroup', 'tr', 'td', 'th', ...TABLE_SECTIONS]),
      barrier: IN_TABLE,
    },
  ],
  [
    'table',
    { closedBy: new Set(['table']), barrier: { kind: 'set', names: TABLE_RESTART_BARRIERS } },
  ],
  ['rb', RUBY_END],
  ['rt', RUBY_END],
  ['rp', RUBY_END],
  ['rtc', RUBY_END],
  ...HEADING_NAMES.map((name): [string, ImpliedEnd] => [name, HEADING_END]),
  ['button', { closedBy: new Set(['button']), barrier: { kind: 'set', names: DEFAULT_SCOPE } }],
  ['nobr', { closedBy: new Set(['nobr']), barrier: { kind: 'set', names: DEFAULT_SCOPE } }],
  ['a', { closedBy: new Set(['a']), barrier: { kind: 'set', names: FORMATTING_MARKERS } }],
  [
    'select',
    {
      closedBy: new Set(['select', 'input', 'keygen', 'textarea']),
      barrier: { kind: 'set', names: new Set() },
    },
  ],
])
// For a start tag: the elements it may close.
const CLOSED_BY: ReadonlyMap<string, readonly string[]> = (() => {
  const closers = new Map<string, string[]>()
  for (const [name, end] of IMPLIED_ENDS) {
    for (const closer of end.closedBy) {
      closers.set(closer, [...(closers.get(closer) ?? []), name])
    }
  }
  return closers
})()
const NOTHING: ReadonlySet<string> = new Set()

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
// `<!-->` and `<!--->` close a comment at once; so does `--!>`.
const SHORT_COMMENT_CLOSE = '->'
const BANG_COMMENT_CLOSE = '--!>'
// `<!--` in a script opens an escape whose two dashes a `>` may close.
const ESCAPE_DASHES = 2
const SCRIPT = 'script'
const IMAGE = 'image'
const PLAINTEXT = 'plaintext'
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
    // A slash marks the tag self-closing only right before its `>`.
    if (html[index] === SELF_CLOSE) {
      isSelfClosing = html[index + 1] === TAG_CLOSE
      index += 1
      continue
    }
    if (html[index] === TAG_CLOSE || index >= html.length) {
      break
    }
    const attributeStart = index
    // A name may begin with `=`, which it keeps (HTML reads it so).
    if (html[index] === ASSIGN) {
      index += 1
    }
    while (!isNameEnd(html[index]) && html[index] !== ASSIGN) {
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

/** Whether `script`, then the end of a tag name, is at `at` (any case). */
function isScriptName(html: string, at: number): boolean {
  return (
    html.slice(at, at + SCRIPT.length).toLowerCase() === SCRIPT &&
    isNameEnd(html[at + SCRIPT.length])
  )
}

/**
 * Where a script's text ends (the index of its `</script`), as HTML's
 * script data states read it: after `<!--`, a `<script` opens a nested one
 * whose `</script>` does not end the script, until `-->` closes the escape.
 */
function scriptEnd(html: string, from: number): number {
  let state: 'data' | 'escaped' | 'doubleEscaped' = 'data'
  let index = from
  while (index < html.length) {
    if (state === 'data') {
      if (html.startsWith(COMMENT_OPEN, index)) {
        state = 'escaped'
        // The dashes stay: a `>` right after them closes the escape.
        index += COMMENT_OPEN.length - ESCAPE_DASHES
        continue
      }
    } else if (html.startsWith(COMMENT_CLOSE, index)) {
      state = 'data'
      index += COMMENT_CLOSE.length
      continue
    }
    if (html.startsWith(END_TAG, index) && isScriptName(html, index + END_TAG.length)) {
      if (state !== 'doubleEscaped') {
        return index
      }
      state = 'escaped'
      index += END_TAG.length + SCRIPT.length
      continue
    }
    if (state === 'escaped' && html[index] === TAG_OPEN && isScriptName(html, index + 1)) {
      state = 'doubleEscaped'
      index += TAG_OPEN.length + SCRIPT.length
      continue
    }
    index += 1
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
function skipMarkup(html: string, start: number, isForeign: boolean): number {
  if (html.startsWith(COMMENT_OPEN, start)) {
    return commentEnd(html, start + COMMENT_OPEN.length)
  }
  // CDATA is a section only in SVG or MathML; in HTML it is a bogus comment.
  if (isForeign && html.startsWith(CDATA_OPEN, start)) {
    const end = html.indexOf(CDATA_CLOSE, start + CDATA_OPEN.length)
    return end === -1 ? html.length : end + CDATA_CLOSE.length
  }
  const end = html.indexOf(TAG_CLOSE, start)
  return end === -1 ? html.length : end + 1
}

/**
 * Where a comment whose text begins at `body` ends: `<!-->` and `<!--->`
 * close at once, otherwise the first `-->` or `--!>` does.
 */
function commentEnd(html: string, body: number): number {
  if (html.startsWith(TAG_CLOSE, body)) {
    return body + TAG_CLOSE.length
  }
  if (html.startsWith(SHORT_COMMENT_CLOSE, body)) {
    return body + SHORT_COMMENT_CLOSE.length
  }
  const close = html.indexOf(COMMENT_CLOSE, body)
  const bang = html.indexOf(BANG_COMMENT_CLOSE, body)
  if (bang !== -1 && (close === -1 || bang < close)) {
    return bang + BANG_COMMENT_CLOSE.length
  }
  return close === -1 ? html.length : close + COMMENT_CLOSE.length
}

const TOMBSTONE = ''
// The element sets whose innermost open member the tree rules ask for.
const TRACKED_SETS = [
  DEFAULT_SCOPE,
  BUTTON_SCOPE,
  LIST_ITEM_SCOPE,
  TABLE_SCOPE,
  TABLE_RESTART_BARRIERS,
  SPECIAL,
  LIST_SCOPE,
  FORMATTING_MARKERS,
  INTEGRATION_POINTS,
] as const

/**
 * The open elements, innermost last. Each name's positions and each tracked
 * set's positions are kept as stacks, so every question the tree rules ask
 * (is it open, is it in scope, is a barrier above it) is answered without
 * walking a hostile page's nesting: each element is pushed and popped once.
 */
class OpenElements {
  private readonly names: string[] = []
  private readonly positions = new Map<string, number[]>()
  private readonly memberPositions = new Map<ReadonlySet<string>, number[]>(
    TRACKED_SETS.map((set) => [set, []]),
  )
  // Open elements "generate implied end tags" would not close, for ruby.
  private readonly notGenerated: number[] = []

  public get length(): number {
    return this.names.length
  }

  public get top(): string | undefined {
    return this.names.at(-1)
  }

  /** Where the innermost open `name` is; -1 when none is open. */
  public lastOf(name: string): number {
    return this.positions.get(name)?.at(-1) ?? -1
  }

  /** Where the innermost open member of a tracked set is; -1 when none is. */
  public lastIn(set: ReadonlySet<string>): number {
    return this.memberPositions.get(set)?.at(-1) ?? -1
  }

  public push(name: string): void {
    const index = this.names.length
    this.names.push(name)
    const own = this.positions.get(name)
    if (own === undefined) {
      this.positions.set(name, [index])
    } else {
      own.push(index)
    }
    for (const [set, stack] of this.memberPositions) {
      if (set.has(name)) {
        stack.push(index)
      }
    }
    if (!GENERATED_ENDS.has(name)) {
      this.notGenerated.push(index)
    }
  }

  /** Closes the element at `index` and every element opened inside it. */
  public popTo(index: number): void {
    while (this.names.length > Math.max(index, 0)) {
      const at = this.names.length - 1
      const name = this.names.pop()
      if (name !== undefined && name !== TOMBSTONE) {
        this.positions.get(name)?.pop()
      }
      for (const stack of [...this.memberPositions.values(), this.notGenerated]) {
        while ((stack.at(-1) ?? -1) >= at) {
          stack.pop()
        }
      }
    }
  }

  /**
   * Takes the innermost `name` out while what was opened inside it stays
   * open (the adoption agency's result for a block inside a formatting
   * element). Its slot stays, empty, so no other position moves.
   */
  public remove(index: number): void {
    const name = this.names[index]
    if (name === undefined || name === TOMBSTONE) {
      return
    }
    this.names[index] = TOMBSTONE
    this.positions.get(name)?.pop()
  }

  /** Whether an element that keeps the one at `index` open against a start tag is open above it. */
  public isBarredAbove(index: number, barrier: Barrier): boolean {
    switch (barrier.kind) {
      case 'anything': {
        return this.names.length - 1 > index
      }
      case 'notGenerated': {
        return (this.notGenerated.at(-1) ?? -1) > index
      }
      case 'set': {
        return this.lastIn(barrier.names) > index
      }
    }
  }

  /** Whether the innermost `name` is open with no element of `scope` above it. */
  public isInScope(name: string, scope: ReadonlySet<string>): boolean {
    const at = this.lastOf(name)
    return at !== -1 && this.lastIn(scope) <= at
  }

  /** Whether a marker element is open at `from` or above, below `to`. */
  public hasMarkerBetween(from: number, to: number): boolean {
    const markers = this.memberPositions.get(FORMATTING_MARKERS) ?? []
    for (let index = markers.length - 1; index >= 0; index -= 1) {
      const at = markers[index] ?? -1
      if (at < from) {
        return false
      }
      if (at < to) {
        return true
      }
    }
    return false
  }
}

/**
 * A hidden or left-out element being passed over: where it is open, what
 * kind it is, and whether it is a formatting element, which HTML reopens
 * after an element around it closed, until its own end tag.
 */
interface Skip {
  readonly index: number
  readonly name: string
  readonly kind: 'hidden' | 'skipped' | 'foreign'
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

/** What a start tag that opens an element makes of its content: hidden, left out, or shown. */
function kindOf(tag: Tag): Skip['kind'] | undefined {
  if (FOREIGN_ROOTS.has(tag.name)) {
    return tag.isSelfClosing ? undefined : 'foreign'
  }
  if (SKIPPED.has(tag.name)) {
    return 'skipped'
  }
  return isHiddenElement(tag) ? 'hidden' : undefined
}

/** A foreign start tag that ends SVG or MathML: most HTML block and phrasing tags. */
function isBreakout(tag: Tag): boolean {
  return (
    BREAKOUT.has(tag.name) ||
    (tag.name === 'font' &&
      FONT_BREAKOUT_ATTRIBUTES.some((attribute) => tag.attributes.has(attribute)))
  )
}

/**
 * The tree as HTML's parser builds it, reduced to what decides visibility:
 * which elements are open, and whether the text being read is inside a
 * hidden or left-out one.
 */
class Tree {
  private readonly open = new OpenElements()
  private skip: Skip | undefined
  private formPointer = false
  /** `<html>` and `<body>` attributes, merged as the parser merges them (first wins). */
  public readonly pageAttributes = new Map<string, string>()

  /** The element at `index` and those inside it closed; a skip they held ends, or reopens. */
  private closeTo(index: number, isOwnEnd = false): void {
    const { skip } = this
    if (skip === undefined || index > skip.index) {
      this.open.popTo(index)
      return
    }
    const isReopened =
      skip.kind === 'hidden' &&
      FORMATTING.has(skip.name) &&
      !(isOwnEnd && index === skip.index) &&
      !this.open.hasMarkerBetween(index, skip.index)
    this.open.popTo(index)
    this.skip = undefined
    if (!isReopened) {
      return
    }
    this.open.push(skip.name)
    this.skip = { ...skip, index: this.open.length - 1 }
  }

  /** The adoption agency, reduced: a block inside stays open; otherwise all inside closes. */
  private adopt(index: number, isOwnEnd: boolean): void {
    if (this.open.lastIn(SPECIAL) > index) {
      this.open.remove(index)
      if (this.skip?.index === index) {
        this.skip = undefined
      }
      return
    }
    this.closeTo(index, isOwnEnd)
  }

  /** Closes what a start tag ends without an end tag (a paragraph, an item, a cell). */
  private closeImplied(name: string): void {
    let lowest = -1
    let isFormatting = false
    const candidates = CLOSED_BY.get(name) ?? []
    for (const candidate of candidates) {
      const at = this.open.lastOf(candidate)
      const end = IMPLIED_ENDS.get(candidate)
      const isOpen = at !== -1 && end !== undefined && !this.open.isBarredAbove(at, end.barrier)
      if (!(isOpen && (lowest === -1 || at < lowest))) {
        continue
      }
      lowest = at
      isFormatting = FORMATTING.has(candidate)
    }
    if (lowest === -1) {
      return
    }
    if (isFormatting) {
      this.adopt(lowest, true)
    } else {
      this.closeTo(lowest, true)
    }
  }

  /**
   * Once what was opened inside a removed element has closed, it is gone
   * too; a skip it held ends.
   */
  private settle(): void {
    while (this.open.top === TOMBSTONE) {
      this.open.popTo(this.open.length - 1)
    }
    if (this.skip !== undefined && this.open.length <= this.skip.index) {
      this.skip = undefined
    }
  }

  private startTag(tag: Tag): string | undefined {
    if (this.isForeign) {
      if (!isBreakout(tag)) {
        if (!tag.isSelfClosing) {
          this.open.push(tag.name)
        }
        return undefined
      }
      this.closeTo(this.skip?.index ?? 0)
    }
    const name = tag.name === IMAGE ? 'img' : tag.name
    if (name === 'html' || name === 'body') {
      for (const [attribute, value] of tag.attributes) {
        if (!this.pageAttributes.has(attribute)) {
          this.pageAttributes.set(attribute, value)
        }
      }
      return undefined
    }
    if (name === 'head' || (name === 'form' && this.formPointer)) {
      return undefined
    }
    // A `<select>` inside a select only closes it.
    const isSelectAgain = name === 'select' && this.open.lastOf('select') !== -1
    this.closeImplied(name)
    if (isSelectAgain) {
      return undefined
    }
    if (VOID.has(name)) {
      // A hidden image says nothing, not even its text alternative.
      return this.isShown && !isHiddenElement(tag) ? name : undefined
    }
    if (name === 'form') {
      this.formPointer = true
    }
    if (FOREIGN_ROOTS.has(name) && tag.isSelfClosing) {
      return this.isShown ? name : undefined
    }
    const kind = this.isShown ? kindOf({ ...tag, name }) : undefined
    this.open.push(name)
    if (kind !== undefined) {
      this.skip = { index: this.open.length - 1, name, kind }
      return undefined
    }
    return this.isShown ? name : undefined
  }

  private endTag(name: string): void {
    const { skip } = this
    if (skip !== undefined && this.isForeign) {
      if (name === 'p' || name === 'br') {
        this.closeTo(skip.index)
      } else if (this.open.lastOf(name) >= skip.index) {
        this.closeTo(this.open.lastOf(name), true)
        return
      }
    }
    this.endInHtml(name)
  }

  private endInHtml(name: string): void {
    if (name === 'form') {
      this.formPointer = false
      const at = this.open.lastOf('form')
      if (at !== -1 && this.open.isInScope('form', DEFAULT_SCOPE)) {
        this.endForm(at)
      }
      return
    }
    if (HEADING_SET.has(name)) {
      const at = Math.max(...HEADING_NAMES.map((heading) => this.open.lastOf(heading)))
      if (at !== -1 && this.open.lastIn(DEFAULT_SCOPE) <= at) {
        this.closeTo(at, true)
      }
      return
    }
    if (FORMATTING.has(name)) {
      const at = this.open.lastOf(name)
      if (at !== -1 && this.open.lastIn(DEFAULT_SCOPE) <= at) {
        this.adopt(at, true)
      }
      return
    }
    const scope = this.scopeOfEnd(name)
    if (scope === undefined) {
      // Any other end tag closes its element only if no special element is inside it.
      const at = this.open.lastOf(name)
      if (at !== -1 && this.open.lastIn(SPECIAL) <= at) {
        this.closeTo(at, true)
      }
      return
    }
    if (this.open.isInScope(name, scope)) {
      this.closeTo(this.open.lastOf(name), true)
    }
  }

  /** The scope an end tag's element must be in to close, or undefined for "any other" end tags. */
  private scopeOfEnd(name: string): ReadonlySet<string> | undefined {
    if (name === 'p') {
      return BUTTON_SCOPE
    }
    if (name === 'li') {
      return LIST_ITEM_SCOPE
    }
    if (TABLE_ENDS.has(name)) {
      return TABLE_SCOPE
    }
    if (name === 'template' || name === 'select') {
      return NOTHING
    }
    return SCOPED_ENDS.has(name) ? DEFAULT_SCOPE : undefined
  }

  /**
   * `</form>` takes the form out while what was opened inside it stays open:
   * a hidden form's content stays hidden until those elements close.
   */
  private endForm(at: number): void {
    if (this.open.length - 1 === at) {
      this.closeTo(at, true)
      return
    }
    this.open.remove(at)
  }

  /** Whether text read now is shown. */
  public get isShown(): boolean {
    return this.skip === undefined
  }

  /** Whether the text being read is SVG or MathML, whose rules differ. */
  public get isForeign(): boolean {
    const { skip } = this
    return skip?.kind === 'foreign' && this.open.lastIn(INTEGRATION_POINTS) <= skip.index
  }

  /** The hidden or left-out element being passed over, if any. */
  public get skipName(): string | undefined {
    return this.skip?.name
  }

  /** A raw-text element (script, style, textarea, title): it closes what it ends, and holds no tags. */
  public startRaw(name: string): void {
    this.closeImplied(name)
    this.settle()
  }

  /**
   * Reads a start tag; returns the name the writer is given for an element
   * shown, or undefined for one hidden, left out or dropped.
   */
  public start(tag: Tag): string | undefined {
    const shown = this.startTag(tag)
    this.settle()
    return shown
  }

  /**
   * Reads an end tag; returns whether the writer sees it: when it was read
   * in shown text, or closed an element around a hidden one (not the hidden
   * element's own end).
   */
  public end(name: string): boolean {
    const wasShown = this.isShown
    const hiddenName = this.skip?.name
    const hiddenAt = this.skip?.index ?? -1
    const target = this.open.lastOf(name)
    this.endTag(name)
    this.settle()
    return (
      wasShown ||
      (target !== -1 && target < hiddenAt) ||
      (this.skip === undefined && name !== hiddenName)
    )
  }
}

/**
 * Where `html` resumes after a `</` that starts no end tag: `</>` is
 * dropped, `</` before anything but a letter opens a bogus comment up to
 * the next `>`, and `</` at the very end is text (undefined).
 */
function strayEndTagEnd(html: string, lt: number): number | undefined {
  const after = lt + END_TAG.length
  if (after >= html.length) {
    return undefined
  }
  if (html[after] === TAG_CLOSE) {
    return after + TAG_CLOSE.length
  }
  const close = html.indexOf(TAG_CLOSE, after)
  return close === -1 ? html.length : close + TAG_CLOSE.length
}

/**
 * The page as Markdown; links and images made absolute against `base`. The
 * conversion stops once the Markdown passes `maxChars` (a hostile page can
 * expand, a relative link into a long absolute one), and says so. What is
 * hidden or left out follows HTML's own parsing rules (`Tree`).
 */
export function htmlToMarkdown(html: string, base: URL, maxChars: number): MarkdownPage {
  const writer = new MarkdownWriter(base, maxChars)
  const tree = new Tree()
  let index = 0
  while (index < html.length && !writer.isFull) {
    const lt = html.indexOf(TAG_OPEN, index)
    const textEnd = lt === -1 ? html.length : lt
    if (tree.isShown && textEnd > index) {
      writer.text(html.slice(index, textEnd))
    }
    if (lt === -1) {
      break
    }
    const next = html[lt + 1]
    if (next === '!' || next === '?') {
      index = skipMarkup(html, lt, tree.isForeign)
      continue
    }
    if (next === SELF_CLOSE && !isAsciiLetter(html[lt + END_TAG.length])) {
      const resume = strayEndTagEnd(html, lt)
      if (resume === undefined) {
        if (tree.isShown) {
          writer.text(END_TAG)
        }
        break
      }
      index = resume
      continue
    }
    const tag = readTag(html, lt)
    if (tag === undefined) {
      if (tree.isShown) {
        writer.text(TAG_OPEN)
      }
      index = lt + 1
      continue
    }
    index = tag.next
    if (!tag.isEnd && !tree.isForeign && RAW_TEXT.has(tag.name)) {
      tree.startRaw(tag.name)
      const end = tag.name === 'script' ? scriptEnd(html, index) : rawTextEnd(html, index, tag.name)
      if (tag.name === 'title' && writer.title === undefined) {
        const title = html.slice(index, Math.min(end, index + MAX_TITLE_SOURCE_CHARS))
        writer.title = collapse(decodeHTML(title)).trim() || undefined
      }
      const close = html.indexOf(TAG_CLOSE, end)
      index = close === -1 || end >= html.length ? html.length : close + 1
      continue
    }
    if (tag.isEnd) {
      if (tree.end(tag.name)) {
        writer.endTag(tag.name)
      }
      continue
    }
    // Everything after `<plaintext>` is its text: no tag ends it.
    const isPlaintext = tag.name === PLAINTEXT && !tree.isForeign
    const shown = tree.start(tag)
    if (shown !== undefined) {
      writer.startTag(shown, tag.attributes)
    }
    if (isPlaintext) {
      if (shown !== undefined) {
        writer.text(html.slice(index))
      }
      break
    }
    if (shown === undefined) {
      continue
    }
    if (tag.isSelfClosing && FOREIGN_ROOTS.has(shown)) {
      writer.endTag(shown)
    }
  }
  const isTruncated = writer.isFull
  const markdown = isHidden(tree.pageAttributes) ? '' : writer.finish()
  return { title: writer.title, markdown, isTruncated }
}
