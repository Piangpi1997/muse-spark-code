// The errors a host throws to the conversation controller (M57, PLAN.md D6):
// the Model API host runs from a bundle of its own whose copies of these
// classes are not this file's, so the controller knows them by name and
// field. A copy is played here by a class of the same shape.

import { describe, expect, it } from 'vitest'
import {
  GoalRefusedError,
  isGoalRefusedError,
  isPromptSettledError,
  isSessionNotLoadedError,
  PromptSettledError,
  SessionNotLoadedError,
} from '../../src/core/agent/agentBackend'

/** Another bundle's copy of a class: same name, same field, a class of its own. */
class OtherBundleError extends Error {
  public constructor(name: string, field: string, value: unknown) {
    super('from the other bundle')
    this.name = name
    Object.defineProperty(this, field, { value, enumerable: true })
  }
}

function copyOf(name: string, field: string, value: unknown): Error {
  return new OtherBundleError(name, field, value)
}

describe('the host errors, known across bundles (M57)', () => {
  it('knows each error, its own class or a copy of it', () => {
    expect(isSessionNotLoadedError(new SessionNotLoadedError('s1', 'gone'))).toBe(true)
    expect(isPromptSettledError(new PromptSettledError('movedOn', 'late'))).toBe(true)
    expect(isGoalRefusedError(new GoalRefusedError('wrongState', 'done'))).toBe(true)
    const notLoaded = copyOf('SessionNotLoadedError', 'sessionId', 's1')
    const settled = copyOf('PromptSettledError', 'reason', 'gone')
    const refused = copyOf('GoalRefusedError', 'refusal', 'noGoal')
    expect(notLoaded).not.toBeInstanceOf(SessionNotLoadedError)
    expect(isSessionNotLoadedError(notLoaded)).toBe(true)
    expect(isPromptSettledError(settled)).toBe(true)
    expect(isGoalRefusedError(refused)).toBe(true)
  })

  it('refuses another name, a field it does not know, and what is not an Error', () => {
    const refused = new GoalRefusedError('noGoal', 'none')
    expect(isPromptSettledError(refused)).toBe(false)
    expect(isSessionNotLoadedError(refused)).toBe(false)
    expect(isGoalRefusedError(copyOf('GoalRefusedError', 'refusal', 'missing_goal'))).toBe(false)
    expect(isPromptSettledError(copyOf('PromptSettledError', 'reason', 'late'))).toBe(false)
    expect(isSessionNotLoadedError(copyOf('SessionNotLoadedError', 'sessionId', 7))).toBe(false)
    expect(isGoalRefusedError(new Error('GoalRefusedError'))).toBe(false)
    expect(isGoalRefusedError({ name: 'GoalRefusedError', refusal: 'noGoal' })).toBe(false)
    expect(isSessionNotLoadedError(undefined)).toBe(false)
  })
})
