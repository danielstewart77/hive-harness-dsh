import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { closeMockServers, mockServer, textEvents } from '../../../packages/llm/llm-pi-ai/tests/mock-server.ts'

it('the built Hive profile completes a custom provider turn without authentication', async () => {
  const root = resolve(import.meta.dirname, '../../..')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-keyless-'))
  const server = await mockServer([{ events: textEvents }, { events: textEvents }])
  try {
    const home = join(directory, '.dsh')
    const profile = join(home, 'profiles/hive')
    await mkdir(join(profile, 'node_modules/@hive'), { recursive: true })
    await mkdir(join(profile, 'node_modules/@deepseek-ai'), { recursive: true })
    await symlink(join(root, 'hive/dsh-headless-resumable'), join(profile, 'node_modules/@hive/dsh-headless-resumable'))
    await symlink(join(root, 'packages/hooks/hooks-claude-code'), join(profile, 'node_modules/@deepseek-ai/dsh-hooks-claude-code'))
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'keyless-profile', private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@hive/dsh-headless-resumable'] } } }))
    await writeFile(join(profile, 'cordis.yml'), '[]\n')
    await writeFile(join(profile, 'cordis.patch.yml'), `
- id: llm-pi-ai
  config:
    providers:
      local:
        api: openai-completions
        baseURL: ${server.url}
        models:
          - id: local-model
            contextWindow: 32768
- id: agent-default-model
  config:
    provider: local
    model: local-model
`)
    const task = join(directory, 'task.txt')
    await writeFile(task, 'Reply briefly without tools.')
    const child = spawn(process.execPath, [join(root, 'apps/cli/lib/bin.js'), '--profile', 'hive',
      '--session-id', randomUUID(), '--task-file', task], {
      cwd: directory, env: { ...process.env, DSH_HOME: home, DSH_HOOKS_CONFIG: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', (value: Buffer) => { stdout += value.toString() })
    child.stderr.on('data', (value: Buffer) => { stderr += value.toString() })
    const timer = setTimeout(() => child.kill('SIGKILL'), 40_000)
    const code = await new Promise<number | null>((accept, reject) => {
      child.once('error', reject)
      child.once('close', accept)
    }).finally(() => { clearTimeout(timer) })
    expect(code, stderr + stdout).toBe(0)
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!) as { outcome: string }
    const request = server.requests[0] as { model: string } | undefined
    expect({ outcome: result.outcome, paths: [...new Set(server.paths)], model: request?.model,
      authorization: server.headers[0]?.authorization, apiKey: server.headers[0]?.['x-api-key'] }).toMatchInlineSnapshot(`
      {
        "apiKey": undefined,
        "authorization": undefined,
        "model": "local-model",
        "outcome": "completed",
        "paths": [
          "/chat/completions",
        ],
      }
    `)
  } finally {
    await closeMockServers()
    await rm(directory, { recursive: true, force: true })
  }
}, 45_000)
