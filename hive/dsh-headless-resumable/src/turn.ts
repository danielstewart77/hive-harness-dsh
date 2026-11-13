/**
 * What a turn was, independent of how the process was driven.
 *
 * The one-shot runner and the resident runner both answer turns and both owe
 * the adapter the same account of one, so the report shape and the walk that
 * builds it live here rather than in either driver. Extracted when the
 * resident driver arrived: leaving them in `index.ts` would have made the two
 * drivers import each other, and a cycle between the module that dispatches
 * and the module it dispatches to is a cycle nobody can read.
 *
 * @module @hive/dsh-headless-resumable/turn
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

import type { ToolTraffic } from './traffic.ts'
import type { SessionMode } from './startup.ts'

/** dsh's own reason for a turn ending, whatever kinds it currently carries. */
export type TurnEndReason = SessionEvent<'turn/end'>['data']['reason']

/** What the adapter reads off stdout: one line of JSON, whatever happened. */
export interface TurnReport {
  /** The conversation this turn ran in — the id we were handed, never a fresh one. */
  sessionId: string
  /** Whether this process opened the conversation or continued it. */
  mode: SessionMode
  /**
   * How the turn ended: dsh's own turn-end reason kind, or `refused` for an
   * invocation that never reached a model. Taken from their type rather than
   * spelled out here, because the set is theirs to extend -- and `max-tokens`
   * in particular is the context ceiling, which is a measurement this loop
   * wants recorded rather than a failure to explain away. `unknown` is an
   * interval holding no turn at all. `rotation_needed` is a goal run that a
   * Stop hook ended because the conversation has outgrown its model: the
   * rounds it did are done, and `goal` says what is left to carry onto a fresh
   * conversation.
   */
  outcome: TurnEndReason['kind'] | 'refused' | 'rotation_needed' | 'unknown'
  /** The last non-empty assistant text of this turn's interval. */
  text: string
  /** The tool traffic of this turn's interval. */
  traffic: ToolTraffic
  /**
   * How many model turns this process actually drove. One unless the dispatch
   * asked for goal rounds. Reported because a build that stopped at round two
   * of forty and one that burned all forty are different failures, and the
   * traffic tally alone cannot tell them apart.
   */
  turns: number
  /** The goal's durable phase when the process finished, when a goal was armed. */
  goalPhase?: string
  /**
   * What a run ended for rotation still owes: the objective to re-dispatch and
   * how many of the rounds it was paying for it never started. Present only
   * with `outcome: rotation_needed`.
   */
  goal?: { objective: string; roundsLeft: number }
  /** Present when something refused or failed: the code and message. */
  error?: { code: string; message: string }
  /**
   * Which turn request this report answers, in a resident process driving many.
   * Absent from a one-shot's report, where the process is the turn and there is
   * nothing to match it against.
   */
  id?: string
}

/**
 * One piece of assistant output as it is produced: prose, or the model's own
 * reasoning when the provider sends it as readable text.
 */
export interface StreamDelta {
  kind: 'text' | 'reasoning'
  text: string
}

/** The last non-empty assistant text, the turn-end reason, and the turn count. */
export function summarize(events: readonly SessionEvent[], firstSeq: number): {
  text: string
  reason: TurnEndReason | undefined
  turns: number
} {
  let started = false
  let text = ''
  let turns = 0
  let reason: TurnEndReason | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      turns += 1
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      if (joined !== '') text = joined
      continue
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason, turns }
}
