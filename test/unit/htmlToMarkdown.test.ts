import { describe, expect, it } from 'vitest'
import { htmlToMarkdown } from '../../src/core/web/htmlToMarkdown'

const BASE = new URL('https://docs.example.com/guide/intro.html')
// Far past anything these pages produce: the bound has its own test.
const UNBOUNDED = 1_000_000

function markdown(html: string): string {
  return htmlToMarkdown(html, BASE, UNBOUNDED).markdown
}

describe('htmlToMarkdown (M69)', () => {
  it('keeps headings, paragraphs, emphasis and the title', () => {
    const page = htmlToMarkdown(
      '<!doctype html><html><head><title> The  Guide </title><style>p{}</style></head>' +
        '<body><h1>Intro</h1><p>Hello <b>bold</b> and <em>soft</em> and <s>gone</s>.</p>' +
        '<h3>Next &amp; last</h3><p>Line one<br>line two</p></body></html>',
      BASE,
      UNBOUNDED,
    )
    expect(page.title).toBe('The Guide')
    expect(page.markdown).toBe(
      '# Intro\n\nHello **bold** and *soft* and ~~gone~~.\n\n### Next & last\n\nLine one\nline two',
    )
  })

  it('makes links and images absolute and drops what a reader cannot follow', () => {
    expect(
      markdown(
        '<p><a href="../api/">API</a>, <a href="https://x.example/">X</a>, ' +
          '<a href="javascript:alert(1)">run</a>, <a href="#top">top</a>, <a href="mailto:a@b.c">mail</a></p>' +
          '<p><img src="/logo.png" alt="Logo"><img src="data:image/png;base64,AAAA" alt="inline">' +
          '<img src="/spacer.gif"></p>',
      ),
    ).toBe(
      '[API](https://docs.example.com/api/), [X](https://x.example/), run, top, [mail](mailto:a@b.c)\n\n' +
        '![Logo](https://docs.example.com/logo.png)',
    )
  })

  it('writes lists, nested lists and quotes', () => {
    expect(
      markdown(
        '<ul><li>one</li><li>two<ul><li>two a</li></ul></li></ul>' +
          '<ol start="3"><li>three</li><li><p>four</p></li></ol>' +
          '<blockquote><p>quoted</p><p>again</p></blockquote>',
      ),
    ).toBe('- one\n- two\n  - two a\n\n3. three\n4. four\n\n> quoted\n\n> again')
  })

  it('fences code blocks with their language and keeps their spacing', () => {
    expect(
      markdown(
        '<pre><code class="language-ts">\nconst a = 1\n  if (a) {\n    `x`\n  }\n</code></pre>' +
          '<p>Use <code>npm test</code> or <code>a`b</code>.</p>',
      ),
    ).toBe('```ts\nconst a = 1\n  if (a) {\n    `x`\n  }\n```\n\nUse `npm test` or ``a`b``.')
    expect(markdown('<pre>has ``` inside</pre>')).toBe('````\nhas ``` inside\n````')
  })

  it('turns a table into rows, escaping pipes and keeping the caption', () => {
    expect(
      markdown(
        '<table><caption>Sizes</caption><tr><th>Name</th><th>Size</th></tr>' +
          '<tr><td>a|b</td><td>1<br>kB</td></tr><tr><td>c</td></tr></table>',
      ),
    ).toBe('Sizes\n\n| Name | Size |\n| --- | --- |\n| a\\|b | 1 kB |\n| c |')
  })

  it('leaves out scripts, styles, media, controls and what the page hides', () => {
    expect(
      markdown(
        '<p>kept</p><script>var x = "</p>not text"</script><noscript>no js</noscript>' +
          '<svg><title>icon</title><text>drawn</text></svg><button>Copy</button>' +
          '<div hidden><p>hidden</p><div>deeper</div></div><span aria-hidden="true">★</span>' +
          '<div style="Display : None">gone</div><template><p>inert</p></template>' +
          '<select><option>pick</option></select><!-- a <b>comment</b> --><p>end</p>',
      ),
    ).toBe('kept\n\nend')
    expect(
      markdown(
        '<p>shown</p><div style="visibility: hidden">invisible</div>' +
          '<div style="content-visibility:hidden">skipped</div>' +
          // A stylesheet's hiding is not seen: this text reaches the model.
          '<style>.x{display:none}</style><p class="x">styled away</p>',
      ),
    ).toBe('shown\n\nstyled away')
  })

  it('reads text the way a browser does: entities, white space, stray brackets', () => {
    // `&not` is one of HTML's legacy references, read even without its `;`.
    expect(
      markdown('<p>a &lt; b &amp;&amp; c&nbsp;&gt; d &copy; &#x41;&#66; &zzz; &notit;</p>'),
    ).toBe('a < b && c > d © AB &zzz; ¬it;')
    expect(markdown('<p>1 < 2 and 3 <> 4</p><p>  spaced \n\t out  </p>')).toBe(
      '1 < 2 and 3 <> 4\n\nspaced out',
    )
    expect(markdown('<P CLASS=x>Upper <B>case</B></P><SCRIPT>x</SCRIPT>')).toBe('Upper **case**')
  })

  it('survives broken markup without losing the text', () => {
    expect(markdown('<p>open <b>bold <i>both</p><p>next')).toBe('open **bold *both***\n\nnext')
    expect(markdown('<div><a href="/x">never closed')).toBe(
      '[never closed](https://docs.example.com/x)',
    )
    expect(markdown('text <a href="x')).toBe('text')
    expect(markdown('<!-- unterminated comment <p>gone</p>')).toBe('')
    expect(markdown('<script>never closed <p>gone</p>')).toBe('')
    // Tag names that are also Object.prototype's own mean nothing here.
    expect(markdown('<toString>x</toString><constructor>y</constructor>')).toBe('xy')
  })

  it('stays linear on a hostile page', () => {
    const deep = `${'<b>'.repeat(20_000)}x${'</b>'.repeat(20_000)}`
    // An item at every level: uncapped, the indents alone would be 25 million characters.
    const lists = '<ul><li>x'.repeat(5000)
    const wide = `<table><tr>${'<td>c</td>'.repeat(5000)}</tr>${'<tr><td>r</td></tr>'.repeat(2000)}</table>`
    const started = performance.now()
    expect(markdown(deep)).toContain('x')
    expect(markdown(lists).length).toBeLessThan(200_000)
    expect(markdown(wide).length).toBeLessThan(300_000)
    expect(performance.now() - started).toBeLessThan(5000)
  })

  it('indents quotes and lists no deeper than four levels', () => {
    // A paragraph first: the page's own leading white space is trimmed.
    expect(markdown(`<p>a</p>${'<ul><li>'.repeat(10)}x`)).toBe('a\n\n        - x')
    expect(markdown(`${'<blockquote>'.repeat(10)}q`)).toBe('> > > > q')
  })

  it('stops at its bound on a page built to expand, and says it did', () => {
    const bound = 100_000
    const longBase = new URL(`https://docs.example.com/${'a'.repeat(1500)}/page.html`)
    // Each 18-character link becomes a 1,500-character absolute one.
    const links = '<a href="x">y</a> '.repeat(250_000)
    // Short rows padded to a wide header; many short lines deep in quotes and lists.
    const rows = `<table><tr>${'<th>h</th>'.repeat(32)}</tr>${'<tr><td>r</td></tr>'.repeat(250_000)}</table>`
    const lines = `${'<blockquote><ul><li>'.repeat(40)}<pre>${'x\n'.repeat(2_000_000)}</pre>`
    const started = performance.now()
    for (const html of [links, rows, lines]) {
      const page = htmlToMarkdown(html, longBase, bound)
      expect(page.isTruncated).toBe(true)
      expect(page.markdown.length).toBeLessThan(bound * 2)
    }
    expect(performance.now() - started).toBeLessThan(5000)
    const small = htmlToMarkdown('<p>short</p>', longBase, bound)
    expect(small).toMatchObject({ markdown: 'short', isTruncated: false })
  })
})
