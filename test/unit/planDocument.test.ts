import { describe, expect, it } from 'vitest'
import {
  isPlanFileName,
  parsePlanFile,
  planBody,
  planFileName,
  planSlug,
  planSteps,
  planTitle,
} from '../../src/core/plans/planDocument'
import {
  PLAN_SLUG_MAX_CHARS,
  PLAN_STEP_MAX_CHARS,
  PLAN_STEPS_MAX,
} from '../../src/shared/constants'
import { CAPTURED_PLAN_BODY, CAPTURED_PLAN_PROMPT, CAPTURED_PLAN_REPLY } from './helpers/m79Capture'

describe('planBody (M79)', () => {
  it('keeps the captured Muse Code plan between its handoff lines, byte for byte', () => {
    expect(planBody(CAPTURED_PLAN_REPLY)).toBe(CAPTURED_PLAN_BODY)
  })

  it('keeps any other reply whole, byte for byte', () => {
    const reply = '# Plan\n\n1. Read.\n2. Write.\n\n'
    expect(planBody(reply)).toBe(reply)
    // The handoff somewhere else than the first line is plan text.
    const quoted = `Intro\n${CAPTURED_PLAN_REPLY}`
    expect(planBody(quoted)).toBe(quoted)
  })

  it('drops a lone opening handoff, and keeps a reply that is only the handoff whole', () => {
    const [lead] = CAPTURED_PLAN_REPLY.split('\n', 1)
    expect(planBody(`${String(lead)}\n\n## Steps\n1. One.`)).toBe('## Steps\n1. One.')
    expect(planBody(String(lead))).toBe(String(lead))
  })
})

describe('planTitle and planSlug (M79)', () => {
  it('names a plan after its top-level heading, unless it only says Plan', () => {
    expect(planTitle('# Dark mode toggle\n\n1. Add it.', 'ask', 'x')).toBe('Dark mode toggle')
    expect(planTitle('# Plan: Dark mode\n', 'ask', 'x')).toBe('Dark mode')
    expect(planTitle('# Plan\n\n1. Add it.', 'Add a dark mode', 'x')).toBe('Add a dark mode')
    // A heading inside code is not the plan's.
    expect(planTitle('```\n# not this\n```\n', 'Real one', 'x')).toBe('Real one')
  })

  it('takes the prompt when the plan has section headings only, its "Plan how to" dropped', () => {
    expect(planTitle(CAPTURED_PLAN_BODY, CAPTURED_PLAN_PROMPT, 'x')).toMatch(
      /^add a README\.md to this folder/,
    )
    expect(planTitle('## Goal', undefined, 'Untitled')).toBe('Untitled')
    expect(planTitle('## Goal', '\n\n', 'Untitled')).toBe('Untitled')
  })

  it('cuts a long title with an ellipsis', () => {
    const title = planTitle(`# ${'word '.repeat(40)}`, undefined, 'x')
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(80)
  })

  it('slugs letters and digits of any script, accents dropped, the rest one hyphen', () => {
    expect(planSlug('Add a README.md — now!')).toBe('add-a-readme-md-now')
    expect(planSlug('Café déjà vu')).toBe('cafe-deja-vu')
    expect(planSlug('ダークモード 2')).toBe('ダークモード-2')
    expect(planSlug('다크 모드')).toBe('다크-모드')
    expect(planSlug('Тёмная тема')).toBe('темная-тема')
    expect(planSlug('हिंदी योजना')).toBe('हिंदी-योजना')
    expect(planSlug('!!!')).toBe('plan')
    const long = planSlug('a'.repeat(PLAN_SLUG_MAX_CHARS - 1) + ' bcd')
    expect(long.length).toBeLessThanOrEqual(PLAN_SLUG_MAX_CHARS)
    expect(long.endsWith('-')).toBe(false)
  })

  it('names the file by the local day, a numeric suffix from the second try', () => {
    const noon = new Date(2026, 8, 27, 12, 0, 0)
    expect(planFileName(noon, 'dark-mode', 1)).toBe('2026-09-27-dark-mode.md')
    expect(planFileName(noon, 'dark-mode', 2)).toBe('2026-09-27-dark-mode-2.md')
    expect(planFileName(new Date(2026, 0, 5), 'x', 1)).toBe('2026-01-05-x.md')
  })
})

describe('parsePlanFile and isPlanFileName (M79)', () => {
  it('reads a plan whole, titled by its top-level heading or its file name', () => {
    expect(parsePlanFile('# Dark mode\n\n1. Do.', '2026-09-27-dark-mode.md')).toEqual({
      title: 'Dark mode',
      body: '# Dark mode\n\n1. Do.',
    })
    expect(parsePlanFile(CAPTURED_PLAN_BODY, '2026-09-27-readme.md')).toEqual({
      title: '2026-09-27-readme',
      body: CAPTURED_PLAN_BODY,
    })
  })

  it('takes only a plan file of its own folder', () => {
    expect(isPlanFileName('2026-09-27-x.md')).toBe(true)
    for (const name of [
      '.md',
      'x.txt',
      '.hidden.md',
      '../x.md',
      'a/b.md',
      String.raw`a\b.md`,
      'c:x.md',
      'x\0.md',
    ]) {
      expect(isPlanFileName(name)).toBe(false)
    }
  })
})

describe('planSteps (M79)', () => {
  it('takes the captured plan’s numbered steps, not its bullets', () => {
    expect(planSteps(CAPTURED_PLAN_BODY)).toEqual([
      'Confirm current folder state with a non-mutating listing to ensure README.md does not already exist.',
      'Confirm the one-sentence description with you during execution.',
      'Create README.md with that single sentence.',
    ])
  })

  it('takes the top-level bullets when nothing is numbered, task boxes and markup gone', () => {
    const body =
      '## Work\n- [ ] **Read** the `config`\n  - nested detail\n* [x] Write it\n+ Test it\n\ncontinuation'
    expect(planSteps(body)).toEqual(['Read the config', 'Write it', 'Test it'])
  })

  it('ignores items inside code and nested items, and caps count and length', () => {
    const body = '1. Real\n```\n2. In code\n```\n   3. Nested under Real\n 4. Still top level'
    expect(planSteps(body)).toEqual(['Real', 'Still top level'])
    const many = Array.from(
      { length: PLAN_STEPS_MAX + 5 },
      (_, index) => `${String(index + 1)}. Step`,
    )
    expect(planSteps(many.join('\n'))).toHaveLength(PLAN_STEPS_MAX)
    const [long] = planSteps(`1. ${'x'.repeat(PLAN_STEP_MAX_CHARS * 2)}`)
    expect(long?.length).toBe(PLAN_STEP_MAX_CHARS)
    expect(planSteps('No list here.')).toEqual([])
  })
})
