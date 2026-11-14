/**
 * A resident dsh surface: one agent, many turns, output that outlives a turn.
 *
 * The one-shot runner answers exactly one turn and exits, which is why a
 * background child dies the moment the turn that sent it closes. Inside one
 * turn that is survivable — the child works while the turn stays open — but a
 * child cannot report *after* the turn ends, and nothing can speak into a
 * conversation no process is currently driving. A chief of staff that
 * dispatches three delegates therefore has to sit on the reply until the
 * slowest one lands.
 *
 * So this driver holds one agent for the life of the session. Turn requests
 * arrive as JSON lines on stdin, output leaves as JSON lines on stdout, and
 * the event subscription is taken once and never dropped — which is the whole
 * point: when `tool-jobs` opens a turn on the idle owner because a background
 * job settled, this process is still here to host it and still listening, so
 * the mind's unprompted words reach the adapter instead of being written into
 * a dead event loop.
 *
 * Why not reuse `runInteractive`: it is the same residency, driven by a person
 * through readline with prose on stdout and a `mind>` prompt. A machine on the
 * other end needs framed turns, a correlation id per turn so a report can be
 * matched to the request that asked for it, and a marker on anything the mind
 * says that nobody asked for. Those are different wire formats over the same
 * lifecycle, and conflating them would put terminal chrome in the adapter's
 * parser.
 *
 * @module @hive/dsh-headless-resumable/resident
 */

import { createInterface } from 'node:readline'

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/cordis-plugin-loader'

import type { SessionMode } from './startup.ts'
import { toolTraffic, NO_TRAFFIC, watchForFailedCall } from './traffic.ts'
import { summarize } from './turn.ts'
import type { TurnReport } from './turn.ts'

/** Identity for a resident process. The task is not here: turns arrive later. */
export interface ResidentConfig {
  sessionId: string
  mode: SessionMode
  /**
   * End a turn at its first failed tool call rather than letting the model
   * drive on past it. Per turn here, not per process: it is a mind under
   * test's whole dispatch shape, and a resident process that ignored it would
   * silently exempt every chat turn from the measurement the one-shot makes.
   */
  stopOnFailedCall?: boolean
}

/** Process-facing effects, separated from stdio so the lifecycle is testable. */
export interface ResidentIo {
  /** Turn requests, one JSON object per line, until end of stream. */
  readonly lines: AsyncIterable<string>
  /** One line of JSON out. The newline is this function's business. */
  write(value: unknown): void
  error(text: string): void
  exit(code: number): void
}

/** One turn the adapter asked for. */
export interface TurnRequest {
  /** The adapter's own handle for this turn, echoed back on its report. */
  id: string
  /** The prompt text. */
  turn: string
}

/**
 * Build the real stdio-backed resident IO.
 *
 * `terminal: false` unconditionally. readline in terminal mode echoes input
 * and emits control sequences, and the far end of this pipe is a parser.
 * @param exit - the launcher's bounded exit request.
 * @returns the IO.
 */
export function stdioIo(exit: (code: number) => void): ResidentIo {
  const rl = createInterface({ input: process.stdin, terminal: false })
  return {
    lines: rl,
    write: (value) => { process.stdout.write(JSON.stringify(value) + '\n') },
    error: (text) => { process.stderr.write(text) },
    exit,
  }
}

/**
 * The turn a line asked for, or a reason it asked for none.
 *
 * A resident process must not die on one bad line. It is the only thing
 * driving the conversation, so a parse failure that took the process down
 * would cost every later turn as well as the malformed one — and the adapter
 * would see the session vanish rather than a request refused.
 * @param line - one line of stdin.
 * @returns the request, or the complaint to write back.
 */
export function parseTurnRequest(line: string): TurnRequest | { error: string } {
  const text = line.trim()
  if (text === '') return { error: 'empty line' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { error: `not JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof parsed !== 'object' || parsed === null) return { error: 'not a JSON object' }
  const row = parsed as Record<string, unknown>
  const turn = row.turn
  const id = row.id
  if (typeof turn !== 'string' || turn === '') return { error: 'no `turn` text' }
  if (typeof id !== 'string' || id === '') return { error: 'no `turn` id' }
  return { id, turn }
}

/** Whether a parse produced a request. */
export function isTurnRequest(result: TurnRequest | { error: string }): result is TurnRequest {
  return (result as { error?: string }).error === undefined
}

/** One assistant message as a line, framed by whether a turn asked for it. */
export function messageLine(text: string, turnId: string | undefined): Record<string, unknown> {
  // `unsolicited` rather than a missing id, because absence is ambiguous on a
  // wire: a sender that forgot the id and a mind that spoke of its own accord
  // would look identical, and only one of them is something to hand Daniel.
  return turnId === undefined
    ? { message: text, unsolicited: true }
    : { message: text, id: turnId }
}

/** The text of a completed assistant message event, or undefined. */
export function completedMessage(event: SessionEvent): string | undefined {
  if (event.type !== 'assistant/message') return undefined
  const text = event.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  return text === '' ? undefined : text
}

/**
 * Hold one conversation open and answer turns until stdin ends.
 * @param ctx - plugin context carrying the agent registry, default model and sessions.
 * @param config - the conversation identity and whether to create or continue it.
 * @param io - process-facing effects.
 */
export async function runResident(
  ctx: Context, config: ResidentConfig, io: ResidentIo,
): Promise<void> {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const selection = defaultModel.currentSelection()
  if (selection.model === undefined || selection.model === '') {
    // Never substituted, for the reason the one-shot gives: a mind quietly
    // running a house favourite is how a wrong model goes unnoticed for weeks.
    io.write({
      sessionId: config.sessionId,
      mode: config.mode,
      outcome: 'refused',
      text: '',
      traffic: NO_TRAFFIC,
      turns: 0,
      error: { code: 'NO_MODEL', message: 'no model was named and none is defaulted here' },
    } satisfies TurnReport)
    io.exit(1)
    return
  }

  const setup = (agentCtx: Context): void => {
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    installModelSelection(agentCtx, selected)
  }
  const agentOptions = { provider: selection.provider, model: selection.model }
  let handle
  try {
    handle = config.mode === 'resume'
      ? await agents.resume({ resumeSessionId: SessionId(config.sessionId), agentOptions, setup })
      : await agents.create({
        sessionId: SessionId(config.sessionId),
        meta: { cwd: process.cwd() },
        agentOptions,
        setup,
      })
  } catch (error) {
    // No fallback to the other mode, exactly as the one-shot refuses: creating
    // where told to continue is how a week of context disappears unlogged.
    io.write({
      sessionId: config.sessionId,
      mode: config.mode,
      outcome: 'refused',
      text: '',
      traffic: NO_TRAFFIC,
      turns: 0,
      error: {
        code: config.mode === 'resume' ? 'NO_SUCH_SESSION' : 'SESSION_NOT_CREATED',
        message: error instanceof Error ? error.message : String(error),
      },
    } satisfies TurnReport)
    io.exit(1)
    return
  }

  const { agent } = handle
  await agent.whenIdle()

  // Which turn is in flight, read by the subscription below to frame what the
  // mind says. `undefined` between turns is not an idle curiosity: it is the
  // state a settled background job speaks into, and the only thing that tells
  // those words apart from an answer somebody is waiting for.
  const state: { current: string | undefined } = { current: undefined }

  // Taken once, before any turn, and never dropped. A per-turn subscription
  // would be deaf in exactly the window this driver exists to cover.
  const stopStreaming = agent.ctx.on('session/event', (session, event) => {
    // This conversation's own events only. Scope containment admits a listener
    // tagged with an ancestor to events dispatched to a descendant key, and an
    // in-process subagent is created from this agent's context — so without
    // this a delegate's prose streams out in the mind's own voice.
    if (session.id !== agent.session.id) return
    if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
      io.write({ delta: { kind: 'text', text: event.data.chunk.text } })
      return
    }
    const text = completedMessage(event)
    if (text !== undefined) io.write(messageLine(text, state.current))
  })

  io.write({ ready: { sessionId: config.sessionId, mode: config.mode, model: selection.model } })

  // Taken before the first turn rather than at the loop head, for the reason
  // the interactive driver gives: the iterator attaches its line listener when
  // it is created, and a request written before that is dropped.
  const lines = io.lines[Symbol.asyncIterator]()
  try {
    for (let next = await lines.next(); next.done !== true; next = await lines.next()) {
      const parsed = parseTurnRequest(next.value)
      if (!isTurnRequest(parsed)) {
        io.write({ refused: parsed.error })
        continue
      }
      const firstSeq = agent.session.seq
      state.current = parsed.id
      // Armed before the turn is sent, so a failure in its first call stops it
      // as readily as one in its last.
      const watch = config.stopOnFailedCall === true
        ? watchForFailedCall(agent as never, firstSeq)
        : undefined
      try {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: parsed.turn }],
          source: { kind: 'user' },
        }))
        await (watch === undefined
          ? agent.whenIdle()
          : Promise.race([agent.whenIdle(), watch.settled]))
        watch?.stop()
        await sessions.flush(agent.session)
        const sofar = summarize(agent.session.events, firstSeq)
        const refusal = watch?.check()
        io.write({
          sessionId: config.sessionId,
          mode: config.mode,
          outcome: sofar.reason?.kind ?? 'unknown',
          text: sofar.text,
          traffic: toolTraffic(agent.session.events, firstSeq),
          turns: sofar.turns,
          id: parsed.id,
          ...(refusal === undefined
            ? sofar.reason?.kind === 'error'
              ? { error: { code: sofar.reason.error.code, message: sofar.reason.error.message } }
              : {}
            : {
              error: {
                code: 'STOPPED_ON_FAILED_CALL',
                // The call as the model spelled it, which side turned it away,
                // and what it said. That is the whole input to the fix, so none
                // of it is dropped.
                message: `${refusal.name}(${refusal.parameters.join(', ')}) failed at the `
                  + `${refusal.origin} with ${refusal.code} (${refusal.errorName}): ${refusal.message}`,
              },
            }),
        } satisfies TurnReport)
      } finally {
        watch?.stop()
        // Cleared after the report, so a job settling during the turn is
        // framed as part of it, and one settling after is not.
        state.current = undefined
      }
    }
  } finally {
    stopStreaming()
  }
  io.exit(0)
}
