/** One agent, many turns, and words that arrive when no turn asked for them. */

import { describe, expect, it } from 'vitest'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'

import {
  completedMessage, isTurnRequest, messageLine, parseTurnRequest, runResident,
} from '../src/resident.ts'
import type { ResidentIo } from '../src/resident.ts'
import { bench } from './support.ts'

/** A writable stream of lines, so a spec can act between two turns. */
function pipe(): {
  lines: AsyncIterable<string>
  push(line: string): void
  end(): void
} {
  const queued: string[] = []
  let wake: (() => void) | undefined
  let done = false
  return {
    lines: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queued.length > 0) yield queued.shift() as string
          if (done) return
          await new Promise<void>((resolve) => { wake = resolve })
        }
      },
    },
    push: (line) => { queued.push(line); wake?.() },
    end: () => { done = true; wake?.() },
  }
}

/** Captured output plus the exit code, as the adapter would see them. */
function capture(): {
  io: Omit<ResidentIo, 'lines'> & { lines?: AsyncIterable<string> }
  written: Record<string, unknown>[]
  err: string[]
  code(): number | undefined
} {
  const written: Record<string, unknown>[] = []
  const err: string[] = []
  let code: number | undefined
  return {
    io: {
      write: (value) => { written.push(value as Record<string, unknown>) },
      error: (text) => { err.push(text) },
      exit: (c) => { code = c },
    },
    written,
    err,
    code: () => code,
  }
}

/** The lines of one kind, in order. */
function kind(written: Record<string, unknown>[], key: string): Record<string, unknown>[] {
  return written.filter(line => line[key] !== undefined)
}

/** The turn reports, which are the lines carrying an outcome. */
function reports(written: Record<string, unknown>[]): Record<string, unknown>[] {
  return written.filter(line => line['outcome'] !== undefined)
}

/** An assistant message appended straight onto the session, as a settled
 * background job's notice turn does: the owner was idle, so dsh opened a turn
 * on it and nobody is waiting for what it says. */
function speakUnprompted(session: Session, text: string, turn: number): void {
  session.append('turn/start', { turn })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'test-provider', model: 'test-model' },
    }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('the turn request', () => {
  it('reads a framed turn and its id', () => {
    const parsed = parseTurnRequest('{"id":"t1","turn":"what stopped?"}')
    expect(isTurnRequest(parsed)).toBe(true)
    expect(parsed).toEqual({ id: 't1', turn: 'what stopped?' })
  })

  it('refuses a line that is not JSON rather than taking the process down', () => {
    const parsed = parseTurnRequest('what stopped?')
    expect(isTurnRequest(parsed)).toBe(false)
  })

  it('refuses a turn with no id, because its report could match nothing', () => {
    expect(isTurnRequest(parseTurnRequest('{"turn":"go"}'))).toBe(false)
  })

  it('refuses an id with no turn text, because there is nothing to answer', () => {
    expect(isTurnRequest(parseTurnRequest('{"id":"t1"}'))).toBe(false)
  })
})

describe('framing what the mind says', () => {
  it('marks words nobody asked for, rather than leaving the id off', () => {
    // A sender that forgot the id and a mind speaking of its own accord would
    // otherwise look identical, and only one is something to hand Daniel.
    expect(messageLine('a child settled', undefined))
      .toEqual({ message: 'a child settled', unsolicited: true })
    expect(messageLine('an answer', 't1')).toEqual({ message: 'an answer', id: 't1' })
  })

  it('ignores an assistant message holding no text', () => {
    const event = { seq: 1, type: 'assistant/message', at: 0, data: { message: { content: [] } } }
    expect(completedMessage(event as never)).toBeUndefined()
  })
})

describe('the resident loop', () => {
  it('answers each turn with a report carrying the id that asked for it', async () => {
    const harness = await bench()
    const out = capture()
    const stdin = pipe()
    stdin.push('{"id":"t1","turn":"first"}')
    stdin.push('{"id":"t2","turn":"second"}')
    stdin.end()

    await runResident(harness.ctx, { sessionId: 'conv-resident-1', mode: 'create' },
      { ...out.io, lines: stdin.lines } as ResidentIo)

    expect(reports(out.written).map(r => r['id'])).toEqual(['t1', 't2'])
    expect(reports(out.written).map(r => r['outcome'])).toEqual(['completed', 'completed'])
    expect(out.code()).toBe(0)
  })

  it('says it is ready before it reads the first turn', async () => {
    // The adapter must not write a turn into a process still creating its
    // session; the first line out is what tells it the conversation exists.
    const harness = await bench()
    const out = capture()
    const stdin = pipe()
    stdin.push('{"id":"t1","turn":"first"}')
    stdin.end()

    await runResident(harness.ctx, { sessionId: 'conv-resident-ready', mode: 'create' },
      { ...out.io, lines: stdin.lines } as ResidentIo)

    expect(out.written[0]?.['ready']).toEqual({
      sessionId: 'conv-resident-ready', mode: 'create', model: 'test-model',
    })
  })

  it('runs every turn in one conversation rather than minting one each time', async () => {
    const harness = await bench()
    const out = capture()
    const stdin = pipe()
    stdin.push('{"id":"t1","turn":"first"}')
    stdin.push('{"id":"t2","turn":"second"}')
    stdin.end()

    await runResident(harness.ctx, { sessionId: 'conv-resident-2', mode: 'create' },
      { ...out.io, lines: stdin.lines } as ResidentIo)

    const ids = new Set(reports(out.written).map(r => r['sessionId']))
    expect([...ids]).toEqual(['conv-resident-2'])
    // Two model turns in one session: the second report's interval is its own.
    expect(reports(out.written).map(r => r['turns'])).toEqual([1, 1])
  })

  it('frames a message produced during a turn with that turn', async () => {
    const harness = await bench()
    const out = capture()
    const stdin = pipe()
    stdin.push('{"id":"t1","turn":"first"}')
    stdin.end()

    await runResident(harness.ctx, { sessionId: 'conv-resident-3', mode: 'create' },
      { ...out.io, lines: stdin.lines } as ResidentIo)

    const messages = kind(out.written, 'message')
    expect(messages.length).toBeGreaterThan(0)
    expect(messages.every(m => m['id'] === 't1')).toBe(true)
    expect(messages.some(m => m['unsolicited'] === true)).toBe(false)
  })

  it('marks a message produced after the turn ended as unsolicited', async () => {
    // The whole reason this driver exists. A background child settles once the
    // turn that sent it has closed, dsh opens a turn on the idle owner, and
    // this process has to still be listening and have somewhere to put it.
    const harness = await bench()
    const out = capture()
    const stdin = pipe()
    const running = runResident(
      harness.ctx, { sessionId: 'conv-resident-4', mode: 'create' },
      { ...out.io, lines: stdin.lines } as ResidentIo,
    )
    stdin.push('{"id":"t1","turn":"dispatch three delegates"}')
    // Wait for that turn's report before speaking, so the words land in the
    // window between turns rather than inside one.
    while (reports(out.written).length === 0) await new Promise(r => setTimeout(r, 5))
    const session = harness.sessions().get(SessionId('conv-resident-4')) as Session
    speakUnprompted(session, 'the second delegate came back refused', 99)
    await new Promise(r => setTimeout(r, 5))
    stdin.end()
    await running

    const late = kind(out.written, 'message').filter(m => m['unsolicited'] === true)
    expect(late.map(m => m['message'])).toEqual(['the second delegate came back refused'])
  })

  it('reports a turn whose tool call was refused under the code that says so', async () => {
    // A mind under test is measured on its tool traffic, and a resident
    // process that ignored the flag would exempt every chat turn from the
    // measurement the one-shot dispatch makes.
    const refusingTurn = (session: never, message: never, turn: number) => {
      const live = session as unknown as {
        append(type: string, data: unknown, options?: unknown): void
      }
      live.append('turn/start', { turn })
      live.append('step/start', { turn, step: 1 })
      live.append('user/message', message, { surfaceOp: 'append' })
      live.append('tool/call', {
        turn, step: 1, callId: `call-${turn}`, name: 'str_replace', arguments: '{"old_str":"a"}',
      })
      live.append('tool/result', {
        turn,
        step: 1,
        message: { role: 'tool', content: [], source: { kind: 'tool', callId: `call-${turn}` } },
        error: { name: 'UnknownToolError', code: 'UNKNOWN_TOOL', message: 'no tool named str_replace' },
      }, { surfaceOp: 'append' })
      live.append('step/end', { turn, step: 1 })
      live.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    const harness = await bench(refusingTurn as never)
    const out = capture()
    const stdin = pipe()
    stdin.push('{"id":"t1","turn":"edit the file"}')
    stdin.end()

    await runResident(
      harness.ctx,
      { sessionId: 'conv-resident-refusal', mode: 'create', stopOnFailedCall: true },
      { ...out.io, lines: stdin.lines } as ResidentIo,
    )

    const error = reports(out.written)[0]?.['error'] as { code: string; message: string }
    expect(error.code).toBe('STOPPED_ON_FAILED_CALL')
    expect(error.message).toContain('str_replace')
  })

  it('leaves an ordinary turn unwatched, so a refused call is not the end of it', async () => {
    const refusing = (session: never, message: never, turn: number) => {
      const live = session as unknown as {
        append(type: string, data: unknown, options?: unknown): void
      }
      live.append('turn/start', { turn })
      live.append('step/start', { turn, step: 1 })
      live.append('user/message', message, { surfaceOp: 'append' })
      live.append('tool/call', {
        turn, step: 1, callId: `call-${turn}`, name: 'str_replace', arguments: '{}',
      })
      live.append('tool/result', {
        turn,
        step: 1,
        message: { role: 'tool', content: [], source: { kind: 'tool', callId: `call-${turn}` } },
        error: { name: 'UnknownToolError', code: 'UNKNOWN_TOOL', message: 'no tool named str_replace' },
      }, { surfaceOp: 'append' })
      live.append('step/end', { turn, step: 1 })
      live.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    const harness = await bench(refusing as never)
    const out = capture()
    const stdin = pipe()
    stdin.push('{"id":"t1","turn":"edit the file"}')
    stdin.end()

    await runResident(harness.ctx, { sessionId: 'conv-resident-unwatched', mode: 'create' },
      { ...out.io, lines: stdin.lines } as ResidentIo)

    expect(reports(out.written)[0]?.['error']).toBeUndefined()
    expect(reports(out.written)[0]?.['outcome']).toBe('completed')
  })

  it('refuses a malformed line and goes on answering the next turn', async () => {
    const harness = await bench()
    const out = capture()
    const stdin = pipe()
    stdin.push('not json at all')
    stdin.push('{"id":"t2","turn":"second"}')
    stdin.end()

    await runResident(harness.ctx, { sessionId: 'conv-resident-5', mode: 'create' },
      { ...out.io, lines: stdin.lines } as ResidentIo)

    expect(kind(out.written, 'refused').length).toBe(1)
    expect(reports(out.written).map(r => r['id'])).toEqual(['t2'])
    expect(out.code()).toBe(0)
  })

  it('refuses to continue a conversation that is not there', async () => {
    // Creating one instead would answer in a conversation with no history and
    // leave the one meant untouched and unfindable.
    const harness = await bench()
    const out = capture()
    const stdin = pipe()
    stdin.end()

    await runResident(harness.ctx, { sessionId: 'conv-never-written', mode: 'resume' },
      { ...out.io, lines: stdin.lines } as ResidentIo)

    expect(reports(out.written).map(r => r['outcome'])).toEqual(['refused'])
    expect((reports(out.written)[0]?.['error'] as { code: string }).code)
      .toBe('NO_SUCH_SESSION')
    expect(out.code()).toBe(1)
  })
})
