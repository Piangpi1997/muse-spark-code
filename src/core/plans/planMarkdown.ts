// A plan read with the panel's own Markdown grammar (M79, PLAN.md D49): its
// top-level heading, its steps, and whether it holds text the panel does not
// show. MarkdownView renders a reply with react-markdown, whose remark-parse
// is `mdast-util-from-markdown`, and the panel's remark-gfm adds
// `micromark-extension-gfm` and `mdast-util-gfm` (no options): the same
// three, at the versions those resolve to, parse the plan here, without
// unified around them. A hand-made line scanner disagreed with it (a backtick
// fence whose info string holds a backtick is no fence), so what it called
// code the panel showed as prose (PR #53 review).
//
// The parser is 114 KiB, so this module is not in the activation bundle: it
// is built into dist/planMarkdown.js (host/planMarkdownEntry.ts), loaded on
// the first plan action (host/planMarkdownBundle.ts); the bundle-split gate
// (scripts/check-bundle-split.mjs) keeps it out of dist/extension.js. It
// imports no value of shared/constants (which would bring the English table
// along): it reads, and planDocument.ts cuts and caps what it read.

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { PlanMarkdown } from './planDocument'

/** The parts of a parsed Markdown node (mdast) this module reads. */
interface MarkdownNode {
  readonly type: string
  readonly value?: string | undefined
  readonly alt?: string | null | undefined
  readonly title?: string | null | undefined
  readonly identifier?: string | undefined
  readonly depth?: number | undefined
  readonly ordered?: boolean | null | undefined
  readonly children?: readonly MarkdownNode[] | undefined
}

const WHITESPACE = /\s+/g
// The panel's parser: remark-parse's options once remark-gfm (no options) is in.
const MARKDOWN_OPTIONS = { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }
// What the panel never shows: raw HTML, block or inline (MarkdownView's
// `skipHtml`); a title (links and pictures render without one); and a
// definition nothing refers to, which renders as nothing at all. A link
// definition serves link and picture references; a footnote, footnote ones.
const HTML_NODE = 'html'
const DEFINITION_KINDS: ReadonlyMap<string, string> = new Map([
  ['definition', 'link'],
  ['footnoteDefinition', 'footnote'],
])
const REFERENCE_KINDS: ReadonlyMap<string, string> = new Map([
  ['linkReference', 'link'],
  ['imageReference', 'link'],
  ['footnoteReference', 'footnote'],
])

/** Text on one line, its runs of white space one space. */
function oneLine(text: string): string {
  return text.replaceAll(WHITESPACE, ' ').trim()
}

/** The plan as the panel parses it. */
function parseMarkdown(text: string): MarkdownNode {
  return fromMarkdown(text, MARKDOWN_OPTIONS)
}

function childrenOf(node: MarkdownNode): readonly MarkdownNode[] {
  return node.children ?? []
}

/** Every node of the tree, depth first. */
function nodesOf(node: MarkdownNode): readonly MarkdownNode[] {
  return [node, ...childrenOf(node).flatMap((child) => nodesOf(child))]
}

/**
 * A node's text as the panel shows it: markup gone, a picture's alt text,
 * and raw HTML left out (an `html` node has a value but no children).
 */
function shownText(node: MarkdownNode): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode': {
      return node.value ?? ''
    }
    case 'image': {
      return node.alt ?? ''
    }
    case 'break': {
      return ' '
    }
    default: {
      return childrenOf(node)
        .map((child) => shownText(child))
        .join('')
    }
  }
}

/** The text of the plan's first top-level heading (`# ` or underlined with `=`), if any. */
export function topHeading(text: string): string | undefined {
  const blocks = childrenOf(parseMarkdown(text))
  for (const node of blocks) {
    const heading = node.type === 'heading' && node.depth === 1 ? oneLine(shownText(node)) : ''
    if (heading !== '') {
      return heading
    }
  }
  return undefined
}

/**
 * Whether the plan holds text the panel does not show, so the user did not
 * see all of what the model would be sent: raw HTML anywhere outside code
 * (a comment, a tag, a declaration), a link's or picture's title, or a
 * definition nothing refers to.
 */
export function hasHiddenMarkup(text: string): boolean {
  const nodes = nodesOf(parseMarkdown(text))
  const referenced = new Set(
    nodes.flatMap((node) => {
      const kind = REFERENCE_KINDS.get(node.type)
      return kind === undefined ? [] : [`${kind}:${node.identifier ?? ''}`]
    }),
  )
  return nodes.some((node) => {
    const kind = DEFINITION_KINDS.get(node.type)
    const isUnreferenced = kind !== undefined && !referenced.has(`${kind}:${node.identifier ?? ''}`)
    return node.type === HTML_NODE || isUnreferenced || (node.title ?? '').trim() !== ''
  })
}

/** A list item's first paragraph as shown (no task box, no markup), on one line. */
function itemText(item: MarkdownNode): string {
  const paragraph = childrenOf(item).find((child) => child.type === 'paragraph')
  return oneLine(paragraph === undefined ? '' : shownText(paragraph))
}

/**
 * The items of the plan's top-level numbered lists, or, when it numbers
 * none, of its top-level bulleted lists, as the panel parses them, empty
 * ones left out. Nested items and further paragraphs belong to their item.
 */
export function listItems(body: string): readonly string[] {
  const ordered: string[] = []
  const bullets: string[] = []
  const blocks = childrenOf(parseMarkdown(body))
  for (const list of blocks) {
    if (list.type !== 'list') {
      continue
    }
    for (const item of childrenOf(list)) {
      const text = itemText(item)
      if (text !== '') {
        ;(list.ordered === true ? ordered : bullets).push(text)
      }
    }
  }
  return ordered.length > 0 ? ordered : bullets
}

/** All three, as dist/planMarkdown.js exports them. */
export const PLAN_MARKDOWN: PlanMarkdown = { topHeading, listItems, hasHiddenMarkup }
