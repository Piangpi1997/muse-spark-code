// Local scheduled prompts for the Model API backend (PLAN.md M52). Parsing and
// next-fire calculation are pure. The host owns persistence and admission;
// nothing in this module sends a model request.

import {
  CRON_FIELD_COUNT,
  CRON_FIELD_SEGMENT_LIMIT,
  CRON_MAX_DAY,
  CRON_MAX_HOUR,
  CRON_MAX_MINUTE,
  CRON_MAX_MONTH,
  CRON_MAX_WEEKDAY,
  MILLISECONDS_PER_DAY,
  SCHEDULE_DEFAULT_INTERVAL_MS,
  SCHEDULE_MAX_INTERVAL_MS,
  SCHEDULE_MAX_PROMPT_CHARS,
  SCHEDULE_MIN_INTERVAL_MS,
} from '../../../shared/constants'
import type { ScheduleCadence } from '../../../shared/schedule'

export type LoopCommand =
  | { readonly verb: 'create'; readonly cadence: ScheduleCadence; readonly prompt: string }
  | { readonly verb: 'list' }
  | { readonly verb: 'cancel'; readonly id: string }

export type LoopParseResult =
  | { readonly ok: true; readonly command: LoopCommand }
  | { readonly ok: false; readonly reason: 'empty' | 'badCadence' | 'badPrompt' | 'badId' }

const LOOP_PREFIX = /^\/loop(?:\s+([\s\S]*))?$/i
const INTERVAL = /^(\d+)([mhd])$/i
const QUOTED_CRON = /^"([^"]+)"(?:\s+([\s\S]*))?$/
const FIRST_WORD = /^(\S+)(?:\s+([\s\S]*))?$/
const JOB_ID = /^[A-Za-z0-9_-]+$/
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
const MINUTE_MS = MILLISECONDS_PER_DAY / (HOURS_PER_DAY * MINUTES_PER_HOUR)
const HOUR_MS = MILLISECONDS_PER_DAY / HOURS_PER_DAY
const INTERVAL_UNITS: Readonly<Record<string, number>> = {
  m: MINUTE_MS,
  h: HOUR_MS,
  d: MILLISECONDS_PER_DAY,
}

interface CronField {
  readonly values: ReadonlySet<number>
  readonly isWildcard: boolean
}

interface ParsedCron {
  readonly minute: CronField
  readonly hour: CronField
  readonly day: CronField
  readonly month: CronField
  readonly weekday: CronField
}

function cronField(
  source: string,
  low: number,
  high: number,
  isWeekday = false,
): CronField | undefined {
  const values = new Set<number>()
  for (const segment of source.split(',')) {
    const [base, stepText, extra] = segment.split('/', CRON_FIELD_SEGMENT_LIMIT)
    if (
      base === undefined ||
      extra !== undefined ||
      (stepText !== undefined && !/^\d+$/.test(stepText))
    ) {
      return undefined
    }
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isSafeInteger(step) || step < 1) {
      return undefined
    }
    let start: number
    let end: number
    if (base === '*') {
      start = low
      end = high
    } else {
      const range = /^(\d+)(?:-(\d+))?$/.exec(base)
      if (range === null) {
        return undefined
      }
      start = Number(range[1])
      end = range[2] === undefined ? (stepText === undefined ? start : high) : Number(range[2])
    }
    if (start < low || end > high || start > end) {
      return undefined
    }
    for (let value = start; value <= end; value += step) {
      values.add(isWeekday && value === CRON_MAX_WEEKDAY ? 0 : value)
    }
  }
  return values.size === 0 ? undefined : { values, isWildcard: source.includes('*') }
}

function parsedCron(expression: string): ParsedCron | undefined {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== CRON_FIELD_COUNT) {
    return undefined
  }
  const minute = cronField(parts[0] ?? '', 0, CRON_MAX_MINUTE)
  const hour = cronField(parts[1] ?? '', 0, CRON_MAX_HOUR)
  const day = cronField(parts[2] ?? '', 1, CRON_MAX_DAY)
  const month = cronField(parts[3] ?? '', 1, CRON_MAX_MONTH)
  const weekday = cronField(parts[4] ?? '', 0, CRON_MAX_WEEKDAY, true)
  return minute === undefined ||
    hour === undefined ||
    day === undefined ||
    month === undefined ||
    weekday === undefined
    ? undefined
    : { minute, hour, day, month, weekday }
}

function isCronMatch(cron: ParsedCron, date: Date): boolean {
  const isDay = cron.day.values.has(date.getDate())
  const isWeekday = cron.weekday.values.has(date.getDay())
  // Cron ORs these fields only when neither contains '*'. A step such as
  // '*/2' still has to match its own values when the fields are ANDed.
  const isDayMatch =
    cron.day.isWildcard || cron.weekday.isWildcard ? isDay && isWeekday : isDay || isWeekday
  return (
    cron.minute.values.has(date.getMinutes()) &&
    cron.hour.values.has(date.getHours()) &&
    cron.month.values.has(date.getMonth() + 1) &&
    isDayMatch
  )
}

/** First matching local-time minute after `afterMs`, bounded by expiry. */
function nextCronFire(
  expression: string,
  afterMs: number,
  expiresAtMs: number,
): number | undefined {
  const cron = parsedCron(expression)
  if (cron === undefined) {
    return undefined
  }
  const start = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS
  for (let time = start; time <= expiresAtMs; time += MINUTE_MS) {
    if (isCronMatch(cron, new Date(time))) {
      return time
    }
  }
  return undefined
}

/** Returns next eligible occurrence; no backlog or replay of missed intervals. */
export function nextScheduleFire(
  cadence: ScheduleCadence,
  afterMs: number,
  expiresAtMs: number,
): number | undefined {
  if (cadence.kind === 'cron') {
    return nextCronFire(cadence.expression, afterMs, expiresAtMs)
  }
  const next = afterMs + cadence.everyMs
  return next <= expiresAtMs ? next : undefined
}

/** A local `/loop` command; undefined when the text is an ordinary prompt. */
export function parseLoopPrompt(text: string): LoopParseResult | undefined {
  const match = LOOP_PREFIX.exec(text.trim())
  if (match === null) {
    return undefined
  }
  const body = (match[1] ?? '').trim()
  if (body === '') {
    return { ok: false, reason: 'empty' }
  }
  if (body.toLowerCase() === 'list') {
    return { ok: true, command: { verb: 'list' } }
  }
  if (/^cancel(?:\s|$)/i.test(body)) {
    const id = body.slice('cancel'.length).trim()
    return JOB_ID.test(id)
      ? { ok: true, command: { verb: 'cancel', id } }
      : { ok: false, reason: 'badId' }
  }
  const quoted = QUOTED_CRON.exec(body)
  if (quoted === null && body.startsWith('"')) {
    return { ok: false, reason: 'badCadence' }
  }
  const words = FIRST_WORD.exec(body)
  const interval = words === null ? null : INTERVAL.exec(words[1] ?? '')
  let cadence: ScheduleCadence
  let prompt: string
  if (quoted !== null) {
    cadence = { kind: 'cron', expression: quoted[1] ?? '' }
    prompt = (quoted[2] ?? '').trim()
    if (parsedCron(cadence.expression) === undefined) {
      return { ok: false, reason: 'badCadence' }
    }
  } else if (interval === null) {
    cadence = { kind: 'interval', everyMs: SCHEDULE_DEFAULT_INTERVAL_MS }
    prompt = body
  } else {
    const unit = INTERVAL_UNITS[(interval[2] ?? '').toLowerCase()]
    const everyMs = Number(interval[1]) * (unit ?? 0)
    if (
      !Number.isSafeInteger(everyMs) ||
      everyMs < SCHEDULE_MIN_INTERVAL_MS ||
      everyMs > SCHEDULE_MAX_INTERVAL_MS
    ) {
      return { ok: false, reason: 'badCadence' }
    }
    cadence = { kind: 'interval', everyMs }
    prompt = (words?.[2] ?? '').trim()
  }
  return prompt === '' || prompt.length > SCHEDULE_MAX_PROMPT_CHARS
    ? { ok: false, reason: 'badPrompt' }
    : { ok: true, command: { verb: 'create', cadence, prompt } }
}
