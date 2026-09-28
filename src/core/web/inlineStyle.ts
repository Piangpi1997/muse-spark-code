// Whether an element's own `style` attribute hides it (M69, PLAN.md D49):
// `display: none` and `content-visibility: hidden` leave it and all it holds
// out; `visibility: hidden` or `collapse` is inherited, and a descendant may
// show again with `visibility: visible`. The declarations are read with a CSS Syntax tokenizer
// (@csstools/css-tokenizer), so comments, escapes, case and `!important` are
// read as a browser reads them; blocks nest as CSS nests them, so a stray
// closing bracket closes nothing. A later declaration overrides an earlier
// one only when a browser would accept its value (the `display` grammar as
// Chromium implements it), and a value resolved later (`var()`) on a hiding
// property counts as hiding, since what it resolves to is not known here. A
// stylesheet's rules are not read: text a class hides still reaches the
// model, marked untrusted.

import { type CSSToken, tokenize, TokenType } from '@csstools/css-tokenizer'

// The values that hide, by property.
const HIDING: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['display', new Set(['none'])],
  ['visibility', new Set(['hidden', 'collapse'])],
  ['content-visibility', new Set(['hidden'])],
])
const CSS_WIDE = ['inherit', 'initial', 'unset', 'revert', 'revert-layer']
// `display` as one keyword, as Chromium accepts it (run-in and the ruby
// containers it rejects are left out, so they cannot undo an earlier none).
const DISPLAY_ONE = new Set([
  ...CSS_WIDE,
  'none',
  'contents',
  'block',
  'inline',
  'flow',
  'flow-root',
  'table',
  'flex',
  'grid',
  'ruby',
  'math',
  'list-item',
  'inline-block',
  'inline-table',
  'inline-flex',
  'inline-grid',
  'table-row-group',
  'table-header-group',
  'table-footer-group',
  'table-row',
  'table-cell',
  'table-column-group',
  'table-column',
  'table-caption',
  'ruby-text',
  '-webkit-box',
  '-webkit-inline-box',
])
// `display` as two or three keywords: an outside and an inside one, or a
// list item with at most an outside one and flow or flow-root.
const DISPLAY_OUTSIDE = new Set(['block', 'inline'])
const DISPLAY_INSIDE = new Set(['flow', 'flow-root', 'table', 'flex', 'grid', 'ruby', 'math'])
const LIST_ITEM = 'list-item'
const LIST_ITEM_INSIDE = new Set(['flow', 'flow-root'])
const DISPLAY_MAX_KEYWORDS = 3
const DISPLAY_PAIR = 2
const VALID_SINGLE: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['visibility', new Set([...CSS_WIDE, 'visible', 'hidden', 'collapse'])],
  ['content-visibility', new Set([...CSS_WIDE, 'visible', 'auto', 'hidden'])],
])
const IMPORTANT = 'important'
const BANG = '!'
// `!` and `important`: the two tokens that end an important declaration.
const IMPORTANT_TOKENS = 2
// Functions a value may hold that a browser resolves later (valid as written).
const DEFERRED_FUNCTIONS = new Set(['var', 'env', 'attr'])
// Each opening token, and the token that closes it.
const CLOSER_OF: ReadonlyMap<string, string> = new Map([
  [TokenType.OpenParen, TokenType.CloseParen],
  [TokenType.Function, TokenType.CloseParen],
  [TokenType.OpenSquare, TokenType.CloseSquare],
  [TokenType.OpenCurly, TokenType.CloseCurly],
])

interface Declaration {
  readonly name: string
  /** The value's keywords, lower case; undefined when it holds anything else. */
  readonly keywords: readonly string[] | undefined
  /** A value a browser resolves later (`var()`): valid, but not known here. */
  readonly isDeferred: boolean
  readonly isImportant: boolean
}

function isSignificant(token: CSSToken): boolean {
  return token[0] !== TokenType.Whitespace && token[0] !== TokenType.Comment
}

/** The declarations of a style attribute: its semicolon-separated parts outside any block. */
function partsOf(tokens: readonly CSSToken[]): CSSToken[][] {
  const parts: CSSToken[][] = [[]]
  const closers: string[] = []
  for (const token of tokens) {
    if (token[0] === TokenType.EOF) {
      break
    }
    const closer = CLOSER_OF.get(token[0])
    if (closer !== undefined) {
      closers.push(closer)
    } else if (token[0] === closers.at(-1)) {
      closers.pop()
    }
    if (closers.length === 0 && token[0] === TokenType.Semicolon) {
      parts.push([])
      continue
    }
    parts.at(-1)?.push(token)
  }
  return parts
}

/** A token's name when it is an identifier (escapes resolved), lower case. */
function identOf(token: CSSToken | undefined): string | undefined {
  return token?.[0] === TokenType.Ident ? token[4].value.toLowerCase() : undefined
}

/** One `name: value [!important]` part, or undefined when it is not a declaration. */
function declarationOf(part: readonly CSSToken[]): Declaration | undefined {
  const tokens = part.filter((token) => isSignificant(token))
  const name = identOf(tokens[0])
  if (name === undefined || tokens[1]?.[0] !== TokenType.Colon) {
    return undefined
  }
  let value = tokens.slice(2)
  const bang = value.at(-IMPORTANT_TOKENS)
  const isImportant =
    bang?.[0] === TokenType.Delim && bang[4].value === BANG && identOf(value.at(-1)) === IMPORTANT
  if (isImportant) {
    value = value.slice(0, -IMPORTANT_TOKENS)
  }
  const isDeferred = value.some(
    (token) =>
      token[0] === TokenType.Function && DEFERRED_FUNCTIONS.has(token[4].value.toLowerCase()),
  )
  const keywords = value.map((token) => identOf(token))
  const isKeywords =
    keywords.length > 0 && keywords.every((keyword): keyword is string => keyword !== undefined)
  return { name, keywords: isKeywords ? keywords : undefined, isDeferred, isImportant }
}

/** Whether `display` accepts the keywords (CSS Display's grammar, as Chromium implements it). */
function isDisplayValue(keywords: readonly string[]): boolean {
  const [only] = keywords
  if (keywords.length === 1) {
    return only !== undefined && DISPLAY_ONE.has(only)
  }
  if (keywords.length > DISPLAY_MAX_KEYWORDS) {
    return false
  }
  const outside = keywords.filter((keyword) => DISPLAY_OUTSIDE.has(keyword))
  const inside = keywords.filter((keyword) => DISPLAY_INSIDE.has(keyword))
  const listItems = keywords.filter((keyword) => keyword === LIST_ITEM)
  if (
    outside.length + inside.length + listItems.length !== keywords.length ||
    outside.length > 1 ||
    inside.length > 1 ||
    listItems.length > 1
  ) {
    return false
  }
  return listItems.length === 1
    ? inside.every((keyword) => LIST_ITEM_INSIDE.has(keyword))
    : keywords.length === DISPLAY_PAIR && outside.length === 1 && inside.length === 1
}

/** Whether a browser would accept the declaration's value for its property. */
function isValid(declaration: Declaration): boolean {
  const { keywords } = declaration
  if (declaration.isDeferred) {
    return true
  }
  if (keywords === undefined) {
    return false
  }
  if (declaration.name === 'display') {
    return isDisplayValue(keywords)
  }
  const [only] = keywords
  return (
    keywords.length === 1 &&
    only !== undefined &&
    VALID_SINGLE.get(declaration.name)?.has(only) === true
  )
}

/** Whether the declaration that won hides: a hiding keyword, or a value resolved later. */
function isHiding(declaration: Declaration): boolean {
  if (declaration.isDeferred) {
    return true
  }
  const [keyword, ...rest] = declaration.keywords ?? []
  return (
    keyword !== undefined &&
    rest.length === 0 &&
    HIDING.get(declaration.name)?.has(keyword) === true
  )
}

/**
 * What an element's inline style says of whether it shows. `display: none`
 * and `content-visibility: hidden` leave the element and all it holds out;
 * `visibility` is inherited, and a descendant may show again with
 * `visibility: visible`.
 */
export interface InlineVisibility {
  readonly isDiscarded: boolean
  /** `visibility` set here: hidden (or collapse), visible, or undefined to inherit. */
  readonly visibility: 'hidden' | 'visible' | undefined
}

/** The winning `visibility` as the walk carries it: a value resolved later counts as hidden. */
function visibilityOf(declaration: Declaration): InlineVisibility['visibility'] {
  if (declaration.isDeferred) {
    return 'hidden'
  }
  const [keyword] = declaration.keywords ?? []
  if (keyword === 'hidden' || keyword === 'collapse') {
    return 'hidden'
  }
  // `initial` is visible; inherit, unset, revert and revert-layer take the parent's.
  return keyword === 'visible' || keyword === 'initial' ? 'visible' : undefined
}

/** What the element's `style` attribute says of whether it shows. */
export function inlineVisibility(style: string): InlineVisibility {
  const winning = new Map<string, Declaration>()
  const parts = partsOf(tokenize({ css: style }))
  for (const part of parts) {
    const declaration = declarationOf(part)
    if (declaration === undefined || !HIDING.has(declaration.name) || !isValid(declaration)) {
      continue
    }
    const current = winning.get(declaration.name)
    if (current?.isImportant === true && !declaration.isImportant) {
      continue
    }
    winning.set(declaration.name, declaration)
  }
  const display = winning.get('display')
  const contentVisibility = winning.get('content-visibility')
  const visibility = winning.get('visibility')
  return {
    isDiscarded:
      (display !== undefined && isHiding(display)) ||
      (contentVisibility !== undefined && isHiding(contentVisibility)),
    visibility: visibility === undefined ? undefined : visibilityOf(visibility),
  }
}
