// The agent's questions (`request_user_input`) in an ACP client (PLAN.md
// D62): a form where the client can show one (`elicitation/create`), and
// otherwise the questions as text, declined so the model carries on and the
// user answers in the next prompt. Pure.

import type { ElicitationPropertySchema, ElicitationSchema } from '@agentclientprotocol/sdk'
import * as z from 'zod/mini'
import type { Question, QuestionAnswer } from '../shared/agentEvents'
import { UI_TEXT } from '../shared/constants'

const MULTIPLE_SELECTION = 'multiple'
const LINE = '\n'
const BULLET = '- '

function enumOptions(question: Question) {
  return question.options.map((option) => ({
    const: option.label,
    title: option.label,
    ...(option.description !== undefined && { description: option.description }),
  }))
}

function questionProperty(question: Question): ElicitationPropertySchema {
  const titled = { title: question.header, description: question.question }
  if (question.selection.mode === MULTIPLE_SELECTION) {
    return {
      type: 'array',
      ...titled,
      items: { anyOf: enumOptions(question) },
      ...(question.selection.minSelections !== undefined && {
        minItems: question.selection.minSelections,
      }),
      ...(question.selection.maxSelections !== undefined && {
        maxItems: question.selection.maxSelections,
      }),
    }
  }
  return question.options.length === 0
    ? { type: 'string', ...titled }
    : { type: 'string', ...titled, oneOf: enumOptions(question) }
}

/** One form field per question, each required, as the card asks for an answer to each. */
export function questionForm(questions: readonly Question[]): ElicitationSchema {
  return {
    type: 'object',
    properties: Object.fromEntries(
      questions.map((question) => [question.id, questionProperty(question)]),
    ),
    required: questions.map((question) => question.id),
  }
}

// The client's answer to `elicitation/create`, checked before use (AGENTS.md
// rule 7): the ACP SDK checks what it receives, not what a request of ours
// gets back. The form asks only for text and lists of option labels.
const formResponseSchema = z.object({
  action: z.literal('accept'),
  content: z.optional(z.nullable(z.record(z.string(), z.unknown()))),
})
const formValueSchema = z.union([z.string(), z.array(z.string())])

/** Several options, each one offered, none twice, as many as the question allows. */
function selectionAnswer(
  question: Question,
  labels: readonly string[],
): QuestionAnswer | undefined {
  const offered = new Set(question.options.map((option) => option.label))
  const isFitting =
    labels.every((label) => offered.has(label)) &&
    new Set(labels).size === labels.length &&
    labels.length >= (question.selection.minSelections ?? 0) &&
    labels.length <= (question.selection.maxSelections ?? offered.size)
  return isFitting ? { questionId: question.id, selectedLabels: [...labels] } : undefined
}

/** One field's answer; a text that is not an option is free text, as the panel's Other. */
function fieldAnswer(question: Question, raw: unknown): QuestionAnswer | undefined {
  const parsed = formValueSchema.safeParse(raw)
  if (!parsed.success) {
    return undefined
  }
  const value = parsed.data
  const isMultiple = question.selection.mode === MULTIPLE_SELECTION
  if (typeof value !== 'string') {
    return isMultiple ? selectionAnswer(question, value) : undefined
  }
  if (isMultiple || value.trim() === '') {
    return undefined
  }
  return question.options.some((option) => option.label === value)
    ? { questionId: question.id, selectedLabel: value }
    : { questionId: question.id, freeText: value }
}

/**
 * The form's answers as the backend takes them, or `undefined` (the
 * questions are declined) when the form was not accepted or any answer is
 * missing or does not fit its question: each field was required.
 */
export function formAnswers(
  questions: readonly Question[],
  response: unknown,
): readonly QuestionAnswer[] | undefined {
  const parsed = formResponseSchema.safeParse(response)
  if (!parsed.success) {
    return undefined
  }
  const content = parsed.data.content ?? {}
  const answers = questions.map((question) => fieldAnswer(question, content[question.id]))
  return answers.every((answer) => answer !== undefined) ? answers : undefined
}

/** The questions as a message, for a client without forms. */
export function questionsText(questions: readonly Question[]): string {
  const lines = questions.flatMap((question) => [
    question.question,
    ...question.options.map((option) => `${BULLET}${option.label}`),
  ])
  return [UI_TEXT.acpQuestionAsked, ...lines].join(LINE)
}
