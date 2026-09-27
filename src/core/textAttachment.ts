// A picked UTF-8 file carried as named text on both backends (M54, PLAN.md D47).

import { MODEL_TEXT } from '../shared/constants'
import { fill } from '../shared/l10n/text'
import type { TextFilePart } from './agent/agentBackend'

export function textFileInput(part: TextFilePart): string {
  return fill(MODEL_TEXT.attachedTextFile, {
    name: JSON.stringify(part.name),
    text: part.text,
  })
}
