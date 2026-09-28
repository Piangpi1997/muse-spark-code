// Whether an element's own `style` attribute hides it (M69, PLAN.md D49):
// `display: none`, `visibility: hidden` or `collapse`, `content-visibility:
// hidden`. The declarations are read with a CSS Syntax tokenizer
// (@csstools/css-tokenizer), so comments, escapes, case and `!important` are
// read as a browser reads them, and a later declaration overrides an
// earlier one only when a browser would accept it. A stylesheet's rules are
// not read: text a class hides still reaches the model, marked untrusted.

import { type CSSToken, tokenize, TokenType } from '@csstools/css-tokenizer'

// The values that hide, by property.
const HIDING: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['display', new Set(['none'])],
  ['visibility', new Set(['hidden', 'collapse'])],
  ['content-visibility', new Set(['hidden'])],
])
// Values a browser accepts for these properties, so a later declaration with
// one of them overrides an earlier `none`; any other keyword makes the later
// declaration invalid, and the earlier one stands.
const CSS_WIDE = ['inherit', 'initial', 'unset', 'revert', 'revert-layer']
const VALID: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'display',
    new Set([
      ...CSS_WIDE,
      'none',
      'contents',
      'block',
      'inline',
      'run-in',
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
      'inline-list-item',
      'table-row-group',
      'table-header-group',
      'table-footer-group',
      'table-row',
      'table-cell',
      'table-column-group',
      'table-column',
      'table-caption',
      'ruby-base',
      'ruby-text',
      'ruby-base-container',
      'ruby-text-container',
      '-webkit-box',
      '-webkit-inline-box',
    ]),
  ],
  ['visibility', new Set([...CSS_WIDE, 'visible', 'hidden', 'collapse'])],
  ['content-visibility', new Set([...CSS_WIDE, 'visible', 'auto', 'hidden'])],
])
const IMPORTANT = 'important'
// `!` and `important`: the two tokens that end an important declaration.
const IMPORTANT_TOKENS = 2
const BANG = '!'
// Functions a value may hold that a browser resolves later (valid as written).
const DEFERRED_FUNCTIONS = new Set(['var', 'env', 'attr'])
const OPENING = new Set<string>([
  TokenType.OpenParen,
  TokenType.OpenSquare,
  TokenType.OpenCurly,
  TokenType.Function,
])
const CLOSING = new Set<string>([TokenType.CloseParen, TokenType.CloseSquare, TokenType.CloseCurly])

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

/** The declarations of a style attribute: its semicolon-separated parts at the top level. */
function partsOf(tokens: readonly CSSToken[]): CSSToken[][] {
  const parts: CSSToken[][] = [[]]
  let depth = 0
  for (const token of tokens) {
    if (token[0] === TokenType.EOF) {
      break
    }
    if (OPENING.has(token[0])) {
      depth += 1
    } else if (CLOSING.has(token[0]) && depth > 0) {
      depth -= 1
    }
    if (depth === 0 && token[0] === TokenType.Semicolon) {
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
  return {
    name,
    keywords: isKeywords ? keywords : undefined,
    isDeferred,
    isImportant,
  }
}

/** Whether a browser would accept the declaration's value for its property. */
function isValid(declaration: Declaration): boolean {
  if (declaration.isDeferred) {
    return true
  }
  const valid = VALID.get(declaration.name)
  const { keywords } = declaration
  if (valid === undefined || keywords === undefined) {
    return false
  }
  // `display` takes up to three keywords (`inline flow-root`, `list-item block`).
  return (
    (keywords.length === 1 || declaration.name === 'display') &&
    keywords.every((keyword) => valid.has(keyword))
  )
}

/** Whether the element's `style` attribute hides it. */
export function isHiddenByStyle(style: string): boolean {
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
  for (const [name, declaration] of winning) {
    const [keyword, ...rest] = declaration.keywords ?? []
    if (keyword !== undefined && rest.length === 0 && HIDING.get(name)?.has(keyword) === true) {
      return true
    }
  }
  return false
}
