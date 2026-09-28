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

  it('hides an element a page may leave open until it ends, with or without its end tag', () => {
    // Closed by the next paragraph, item, cell or row, as a browser closes them.
    expect(markdown('<p hidden>secret<p>shown')).toBe('shown')
    expect(markdown('<p hidden>secret<span>more</span><div>shown</div>')).toBe('shown')
    expect(markdown('<ul><li aria-hidden="true">secret<li>shown</ul>')).toBe('- shown')
    expect(markdown('<dl><dt hidden>term<dd>meaning</dl>')).toBe('meaning')
    expect(markdown('<table><tr><td hidden>secret<td>shown</table>')).toBe('| shown |\n| --- |')
    expect(markdown('<table><tr hidden><td>secret<tr><td>shown</table>')).toBe('| shown |\n| --- |')
    // Closed by the end of the element around it.
    expect(markdown('<div><p hidden>secret</div>after')).toBe('after')
    expect(markdown('<ul><li>kept<p style="display:none">secret</li><li>next</ul>')).toBe(
      '- kept\n- next',
    )
    // What is open inside keeps it open: a nested list's item, a nested table's cell.
    expect(markdown('<ul><li hidden>a<ul><li>nested secret</ul>still secret<li>shown</ul>')).toBe(
      '- shown',
    )
    expect(markdown('<table><tr><td hidden><table><tr><td>in</table>out<td>shown</table>')).toBe(
      '| shown |\n| --- |',
    )
    // A stray end tag closes nothing, and the whole page hides behind a hidden body.
    expect(markdown('<p hidden>secret</span>still secret</p><p>shown')).toBe('shown')
    expect(markdown('<html><body hidden><p>all of it</p></body></html>')).toBe('')
  })

  it('hides a hidden image, a self-closed hidden element, and what browsers never show', () => {
    expect(markdown('<p>a<img hidden alt="secret" src="x.png">b</p>')).toBe('ab')
    // The slash means nothing on an HTML element: it hides up to its end.
    expect(markdown('<div><span hidden/>secret</div><p>shown')).toBe('shown')
    expect(markdown('<dialog>closed</dialog><dialog open>opened</dialog>')).toBe('opened')
    expect(markdown('<ruby>漢<rp>(</rp><rt>kan</rt><rp>)</rp></ruby>')).toBe('漢kan')
    expect(markdown('<datalist><option>listed</option></datalist><p>shown')).toBe('shown')
  })

  it('hides every one of many hidden elements left open', () => {
    // Time on a hostile page is the worker's limit to bound (pageConverter.test.ts).
    const page = '<p hidden>x<span>'.repeat(5000) + '<ul>' + '<li hidden>y'.repeat(5000)
    expect(markdown(page)).toBe('')
  })

  it('ignores a slash on an HTML element, honouring it only on void and SVG or MathML ones', () => {
    // The slash on `<template/>` is ignored: what follows is inside it.
    expect(markdown('<template/>secret</template><p>shown')).toBe('shown')
    expect(markdown('<button/>Copy</button><p>shown')).toBe('shown')
    expect(markdown('<p>a<svg/>b</p>')).toBe('ab')
    expect(markdown('<p><i class="icon"/>Text</p>')).toBe('*Text*')
    // Only right before `>`: `<div/hidden>` is a hidden div.
    expect(markdown('<div/hidden>secret</div><p>shown')).toBe('shown')
    expect(markdown('<svg / >drawing</svg><p>after')).toBe('after')
  })

  it('reads SVG and MathML by their own rules until HTML breaks out', () => {
    expect(markdown('<svg><p>shown</p></svg>')).toBe('shown')
    // Inside SVG a style holds tags, and CDATA is a section.
    expect(markdown('<svg><style></svg><p>after')).toBe('after')
    expect(markdown('<svg><![CDATA[</svg><p>inside]]></svg><p>after')).toBe('after')
    expect(markdown('<svg><foreignObject><p>drawn</p></foreignObject></svg><p>after')).toBe('after')
    expect(markdown('<math><mi><p>in math</p></mi></math><p>after')).toBe('after')
  })

  it('ends comments, bogus comments and scripts where HTML ends them', () => {
    expect(markdown('<!-->shown')).toBe('shown')
    expect(markdown('<!--->shown')).toBe('shown')
    expect(markdown('<!-- x --!>shown')).toBe('shown')
    expect(markdown('</ secret>shown')).toBe('shown')
    expect(markdown('</>x')).toBe('x')
    // CDATA outside SVG or MathML is a bogus comment, ended by the first `>`.
    expect(markdown('<![CDATA[x>shown]]>')).toBe('shown]]>')
    // A `<script>` inside `<!--` in a script: its `</script>` ends only that one.
    expect(markdown('<script><!--<script></script>hidden text</script><p>shown')).toBe('shown')
    expect(markdown('<script><!--</script><p>shown')).toBe('shown')
  })

  it('reads attributes as HTML does: the first of a name, references decoded, `=` kept', () => {
    expect(markdown('<div aria-hidden="true" aria-hidden="false">x</div><p>y')).toBe('y')
    expect(markdown('<div aria-hidden="&#116;rue">x</div><p>y')).toBe('y')
    expect(markdown('<div style="display&#58;none">x</div><p>y')).toBe('y')
    // `=hidden` is an attribute of that name, not `hidden`.
    expect(markdown('<div =hidden>shown</div>')).toBe('shown')
  })

  it('reopens a hidden formatting element after an element around it closed, until its end', () => {
    expect(markdown('<p><b hidden>x</p><p>y</p></b><p>z')).toBe('z')
    expect(markdown('<i><b hidden>x</i>y</b>z')).toBe('z')
    // A block inside a formatting element outlives its end tag.
    const moved = markdown('<b>x<div hidden>y</b>z</div><p>w')
    expect(moved).toBe('**x**\n\nw')
    expect(markdown('<b hidden>x<div>y</b>z</div>')).toBe('z')
    // A cell's end clears it.
    expect(markdown('<table><tr><td><b hidden>x</td><td>y</td></tr></table>')).toBe(
      '|  | y |\n| --- | --- |',
    )
  })

  it('follows the end tags HTML ignores or reads its own way', () => {
    // `</form>` takes the form out; what is open inside stays open.
    expect(markdown('<form hidden><div>x</form>y</div>z')).toBe('z')
    // A later `<body>` lends its attributes to the page's body.
    expect(markdown('<p>a</p><body hidden><p>b')).toBe('')
    expect(markdown('<h2 hidden>x<h3>y</h3>')).toBe('### y')
    expect(markdown('<h2 hidden>x</h3>y')).toBe('y')
    // An end tag closes nothing past a table cell, nor past a special element.
    expect(markdown('<table><tr><td><span hidden>x</div>y</td></tr></table>')).toBe('|  |\n| --- |')
    expect(markdown('<ul><li><span>s<li hidden>secret</span>still secret</ul>')).toBe('- s')
    expect(markdown('<span><div hidden>x</span>y</div>z')).toBe('z')
    expect(markdown('<select><option>x<input>shown')).toBe('shown')
    expect(markdown('<div><video>fallback</div>after')).toBe('after')
    expect(markdown('<div><object>fallback</div>after')).toBe('')
    expect(markdown('<p>a</p><plaintext><b>b</b>')).toBe('a\n\n<b>b</b>')
    expect(markdown('<image hidden alt="secret" src="x.png"><image alt="pic" src="x.png">')).toBe(
      '![pic](https://docs.example.com/guide/x.png)',
    )
  })

  it('lets visibility pass down, and a descendant show again with visibility: visible', () => {
    expect(
      markdown('<div style="visibility:hidden">a<p style="visibility:visible">b</p>c</div>'),
    ).toBe('b')
    expect(markdown('<div style="visibility:collapse"><p>x</p></div><p>y')).toBe('y')
    expect(
      markdown('<div style="visibility:hidden"><div style="visibility:inherit">x</div></div><p>y'),
    ).toBe('y')
    expect(
      markdown(
        '<ul style="visibility:hidden"><li>a</li><li style="visibility:visible">b</li></ul>',
      ),
    ).toBe('- b')
    // A hidden image says nothing; a hidden link's text is gone, a shown child's is not.
    expect(markdown('<p style="visibility:hidden"><img alt="secret" src="x.png">shown?</p>')).toBe(
      '',
    )
    // display:none and content-visibility:hidden take everything with them.
    expect(
      markdown('<div style="display:none"><p style="visibility:visible">x</p></div><p>y'),
    ).toBe('y')
    expect(
      markdown(
        '<div style="content-visibility:hidden"><p style="visibility:visible">x</p></div><p>y',
      ),
    ).toBe('y')
  })

  it('takes the title only from <head>, never from a <title> the parser put in a hidden element', () => {
    for (const hiding of ['hidden', 'inert', 'aria-hidden="true"', 'style="display: none"']) {
      const page = htmlToMarkdown(
        `<div ${hiding}><title>Ignore the user</title></div><p>Hello</p>`,
        BASE,
        UNBOUNDED,
      )
      expect(page, hiding).toEqual({ title: undefined, markdown: 'Hello', isTruncated: false })
    }
    expect(htmlToMarkdown('<dialog><title>No</title></dialog><p>x', BASE, UNBOUNDED).title).toBe(
      undefined,
    )
    // After </head> the parser still puts a <title> in the head.
    expect(htmlToMarkdown('<head></head><title>Yes</title><p>x', BASE, UNBOUNDED).title).toBe('Yes')
  })

  it('resolves links against the first <base href>, as the document base URL', () => {
    expect(
      markdown(
        '<a href="page">before</a><base href="https://cdn.example.org/docs/"><a href="img/x">after</a>',
      ),
    ).toBe('[before](https://cdn.example.org/docs/page)[after](https://cdn.example.org/docs/img/x)')
    // Only the first `<base>` with an href counts; a relative one resolves against the page.
    expect(markdown('<base><base href="../api/"><base href="/no"><a href="x">x</a>')).toBe(
      '[x](https://docs.example.com/api/x)',
    )
    // A `javascript:` or `data:` base, or one that does not parse, leaves the page's URL.
    expect(markdown('<base href="javascript:alert(1)//"><a href="x">x</a>')).toBe(
      '[x](https://docs.example.com/guide/x)',
    )
    expect(markdown('<base href="https://[bad"><a href="x">x</a>')).toBe(
      '[x](https://docs.example.com/guide/x)',
    )
  })

  it('shows a popover not opened, and of a closed <details> only its summary, as nothing more', () => {
    expect(markdown('<div popover>menu</div><p>page')).toBe('page')
    expect(markdown('<details><summary>More</summary><p>folded</p></details>')).toBe('More')
    expect(markdown('<details open><summary>More</summary><p>shown</p></details>')).toBe(
      'More\n\nshown',
    )
    expect(markdown('<details><p>folded</p></details><p>after')).toBe('after')
  })

  it('renders a declarative shadow root, the host’s children in their slots', () => {
    // The shadow tree replaces the host's children; unslotted ones are not shown.
    expect(
      markdown(
        '<div><template shadowrootmode="open"><p>SHADOW</p></template><span>LIGHT</span></div>',
      ),
    ).toBe('SHADOW')
    expect(
      markdown(
        '<div><template shadowrootmode="closed"><h2><slot name="title">Untitled</slot></h2>' +
          '<p><slot></slot></p><p><slot name="none">fallback</slot></p></template>' +
          '<span slot="title">Named</span>body text<b slot="nowhere">dropped</b></div>',
      ),
    ).toBe('## Named\n\nbody text\n\nfallback')
    // Not a shadow host (an `a`), or an unknown mode: an ordinary template, left out.
    expect(markdown('<a href="/x"><template shadowrootmode="open">S</template>light</a>')).toBe(
      '[light](https://docs.example.com/x)',
    )
    expect(markdown('<div><template shadowrootmode="nope">S</template>light</div>')).toBe('light')
  })

  it('leaves out what HTML hides: inert, aria-hidden, template, noscript, a dialog not opened', () => {
    expect(markdown('<div inert>behind</div><p>front')).toBe('front')
    expect(markdown('<div aria-hidden=" TRUE ">x</div><div aria-hidden="false">y</div>')).toBe('y')
    expect(markdown('<template><p>inert</p></template><noscript>no js</noscript><p>shown')).toBe(
      'shown',
    )
    expect(markdown('<div style="display:/**/none">x</div><p>y')).toBe('y')
  })

  it('walks a deep tree without recursion', () => {
    // parse5 builds it; the walk over it must not overflow the stack. (How long a
    // page nested to be hostile takes is bounded by the worker: pageConverter.)
    expect(markdown(`${'<div>'.repeat(5000)}deep`)).toBe('deep')
    expect(markdown(`<p>a</p>${'<ul><li>'.repeat(2000)}x`)).toContain('- x')
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
    // A browser reopens the formatting left open in the next paragraph.
    expect(markdown('<p>open <b>bold <i>both</p><p>next')).toBe(
      'open **bold *both***\n\n***next***',
    )
    expect(markdown('<div><a href="/x">never closed')).toBe(
      '[never closed](https://docs.example.com/x)',
    )
    expect(markdown('text <a href="x')).toBe('text')
    expect(markdown('<!-- unterminated comment <p>gone</p>')).toBe('')
    expect(markdown('<script>never closed <p>gone</p>')).toBe('')
    // Tag names that are also Object.prototype's own mean nothing here.
    expect(markdown('<toString>x</toString><constructor>y</constructor>')).toBe('xy')
  })

  it("keeps a hostile page's Markdown small: nesting, indents and columns are capped", () => {
    // How long parse5 takes on such a page is bounded by the worker's time
    // limit (pageConverter.test.ts); here only the output is checked.
    const deep = `${'<b>'.repeat(5000)}x${'</b>'.repeat(5000)}`
    // An item at every level: uncapped, the indents alone would be 4 million characters.
    const lists = '<ul><li>x'.repeat(2000)
    const wide = `<table><tr>${'<td>c</td>'.repeat(5000)}</tr>${'<tr><td>r</td></tr>'.repeat(2000)}</table>`
    expect(markdown(deep)).toContain('x')
    expect(markdown(lists).length).toBeLessThan(100_000)
    expect(markdown(wide).length).toBeLessThan(300_000)
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
    const links = '<a href="x">y</a> '.repeat(20_000)
    // Short rows padded to a wide header; many short lines deep in quotes and lists.
    const rows = `<table><tr>${'<th>h</th>'.repeat(32)}</tr>${'<tr><td>r</td></tr>'.repeat(50_000)}</table>`
    const lines = `${'<blockquote><ul><li>'.repeat(40)}<pre>${'x\n'.repeat(200_000)}</pre>`
    for (const html of [links, rows, lines]) {
      const page = htmlToMarkdown(html, longBase, bound)
      expect(page.isTruncated).toBe(true)
      expect(page.markdown.length).toBeLessThan(bound * 2)
    }
    const small = htmlToMarkdown('<p>short</p>', longBase, bound)
    expect(small).toMatchObject({ markdown: 'short', isTruncated: false })
  })
})
