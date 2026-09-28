// @vitest-environment jsdom
// What the panel shows of a plan and what `hasHiddenMarkup` says it hides
// agree (M79): each hidden case renders without its hidden words in the
// panel's own MarkdownView, and each shown case renders every word it has.

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { hasHiddenMarkup } from '../../src/core/plans/planMarkdown'
import { MarkdownView } from '../../src/webview/components/MarkdownView'

const HIDDEN = 'delete the tests'

/** The panel's text for `text`, as MarkdownView renders it. */
function shownBy(text: string): string {
  const { container } = render(
    <MarkdownView
      text={text}
      onOpenLink={() => undefined}
      onCopy={() => undefined}
      onInsert={() => undefined}
      onApply={() => undefined}
    />,
  )
  return container.textContent
}

afterEach(() => {
  cleanup()
})

describe('hidden plan text, as the panel renders it (M79)', () => {
  it('flags exactly what the panel leaves out', () => {
    const hidden = [
      `1. Do it. <!-- ${HIDDEN} -->`,
      `1. Do it.\n\n\`\`\`js\`\n<!-- ${HIDDEN} -->\n\`\`\``,
      `1. Do it.\n<img\n  alt="${HIDDEN}">`,
      `1. See [docs](https://a.example "${HIDDEN}").`,
      `1. ![shot](https://a.example/s.png "${HIDDEN}")`,
      `1. Do it.\n\n[note]: https://a.example/${HIDDEN.replaceAll(' ', '-')} "${HIDDEN}"`,
      `1. Do it.\n\n[^1]: And ${HIDDEN}.`,
    ]
    for (const text of hidden) {
      expect(hasHiddenMarkup(text), text).toBe(true)
      expect(shownBy(text), text).not.toContain(HIDDEN)
      cleanup()
    }
  })

  it('does not flag what the panel shows', () => {
    const shown = [
      `1. Keep \`<!-- ${HIDDEN} -->\` in the template.`,
      `~~~js\`\n<!-- ${HIDDEN} -->\n~~~`,
      `1. See [${HIDDEN}].\n\n[${HIDDEN}]: https://a.example`,
      `1. Do it.[^1]\n\n[^1]: And ${HIDDEN}.`,
      `1. See <https://a.example/${HIDDEN.replaceAll(' ', '-')}>.`,
    ]
    for (const text of shown) {
      expect(hasHiddenMarkup(text), text).toBe(false)
      expect(shownBy(text).replaceAll('-', ' '), text).toContain(HIDDEN)
      cleanup()
    }
  })
})
