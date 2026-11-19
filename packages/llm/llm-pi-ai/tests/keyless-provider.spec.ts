import { afterEach, expect, it } from 'vitest'
import { resolveProfiles } from '../src/config.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

afterEach(closeMockServers)

it('a custom provider without a credential sends no authentication headers', async () => {
  const server = await mockServer([{ events: textEvents }])
  const profile = resolveProfiles({ local: { api: 'openai-completions', baseURL: server.url,
    models: [{ id: 'local-model', contextWindow: 32768 }] } }).get('local')!
  const provider = profile.piProvider
  const model = provider.getModels()[0]!
  const events = provider.streamSimple(model, { messages: [{ role: 'user', content: 'fixture request', timestamp: 1 }] }, {})
  const result = await events.result()
  expect(result.stopReason).toBe('stop')
  expect(server.paths).toEqual(['/chat/completions'])
  expect(server.headers[0]?.authorization).toBeUndefined()
  expect(server.headers[0]?.['x-api-key']).toBeUndefined()
})
