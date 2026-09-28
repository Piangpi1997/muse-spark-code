import { describe, expect, it } from 'vitest'
import { isHiddenByStyle } from '../../src/core/web/inlineStyle'

describe('inline styles that hide an element (M69)', () => {
  it('reads display, visibility and content-visibility as a browser does', () => {
    expect(isHiddenByStyle('display: none')).toBe(true)
    expect(isHiddenByStyle('visibility:hidden')).toBe(true)
    expect(isHiddenByStyle('visibility: collapse')).toBe(true)
    expect(isHiddenByStyle('content-visibility: hidden')).toBe(true)
    expect(isHiddenByStyle('display: block; color: red')).toBe(false)
    expect(isHiddenByStyle('')).toBe(false)
  })

  it('sees through comments, escapes and case', () => {
    expect(isHiddenByStyle('display:/**/none')).toBe(true)
    expect(isHiddenByStyle('display:/* x */ none /* y */')).toBe(true)
    expect(isHiddenByStyle(String.raw`dis\play: n\one`)).toBe(true)
    expect(isHiddenByStyle(String.raw`display: \6e one`)).toBe(true)
    expect(isHiddenByStyle('DISPLAY: NONE')).toBe(true)
  })

  it('lets the last valid declaration win, unless an earlier one is important', () => {
    expect(isHiddenByStyle('display: none; display: block')).toBe(false)
    expect(isHiddenByStyle('display: block; display: none')).toBe(true)
    expect(isHiddenByStyle('display: none !important; display: block')).toBe(true)
    expect(isHiddenByStyle('display: none !IMPORTANT ; display: block')).toBe(true)
    // An invalid later value is dropped, as a browser drops it.
    expect(isHiddenByStyle('display: none; display: nonsense')).toBe(true)
    expect(isHiddenByStyle('display: none; display: 12px')).toBe(true)
    expect(isHiddenByStyle('display: none; display: inline flow-root')).toBe(false)
    expect(isHiddenByStyle('display: none; display: list-item block flow')).toBe(false)
    // What display's grammar rejects leaves the earlier none standing.
    for (const value of [
      'block block',
      'none none',
      'inherit inherit',
      'flex grid',
      'run-in',
      'list-item table',
    ]) {
      expect(isHiddenByStyle(`display: none; display: ${value}`), value).toBe(true)
    }
  })

  it('counts a value resolved later (var()) on a hiding property as hiding', () => {
    expect(isHiddenByStyle('display: var(--nope, none)')).toBe(true)
    expect(isHiddenByStyle('--h: none; display: var(--h)')).toBe(true)
    expect(isHiddenByStyle('visibility: var(--v)')).toBe(true)
    expect(isHiddenByStyle('display: none; display: var(--shown)')).toBe(true)
    expect(isHiddenByStyle('color: var(--c)')).toBe(false)
  })

  it('nests blocks as CSS does: a stray closing bracket closes nothing', () => {
    expect(isHiddenByStyle('display:none; x:(]; display:block')).toBe(true)
    expect(isHiddenByStyle('display:none; x:(a); display:block')).toBe(false)
    expect(isHiddenByStyle('x:[}; display:none')).toBe(false)
  })

  it('reads only declarations: not a string, a custom property or another property', () => {
    expect(isHiddenByStyle('content: "display: none"')).toBe(false)
    expect(isHiddenByStyle('--x: none; --y: display:none')).toBe(false)
    expect(isHiddenByStyle('background: url(x;display:none)')).toBe(false)
    expect(isHiddenByStyle('font-display: none')).toBe(false)
    expect(isHiddenByStyle('display none')).toBe(false)
  })
})
