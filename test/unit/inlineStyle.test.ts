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
    // A value resolved later is valid as written, and not known here.
    expect(isHiddenByStyle('display: none; display: var(--shown)')).toBe(false)
    expect(isHiddenByStyle('display: none; display: inline flow-root')).toBe(false)
  })

  it('reads only declarations: not a string, a custom property or another property', () => {
    expect(isHiddenByStyle('content: "display: none"')).toBe(false)
    expect(isHiddenByStyle('--x: none; --y: display:none')).toBe(false)
    expect(isHiddenByStyle('background: url(x;display:none)')).toBe(false)
    expect(isHiddenByStyle('font-display: none')).toBe(false)
    expect(isHiddenByStyle('display none')).toBe(false)
  })
})
