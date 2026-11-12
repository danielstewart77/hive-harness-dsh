/**
 * The credentials a mind's own commands authenticate with.
 *
 * Every child of the harness starts with credential-shaped names scrubbed. The
 * hive profile hands the shell executor the environment the mind spawned the
 * turn with, so a command the model runs still reads the mind's keys. The
 * executor's config here is the one the composed profile (dsh-base under this
 * bundle) gives its shell row, evaluated the way the loader evaluates it.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { interpolate } from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

const CREDENTIAL = 'LUCENT_BEARER_TOKEN'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(context => context.fiber.dispose()))
  delete process.env[CREDENTIAL]
})

/** The bash executor row of the composed hive profile, its `!!js` config evaluated now. */
function hiveShellConfig(ctx: Context): Record<string, unknown> {
  const layer = (relative: string) => loadOverlayPatches('test', fileURLToPath(new URL(relative, import.meta.url)))
  const entries = composeEntries([
    layer('../../../packages/bundle/base/cordis.patch.yml'),
    layer('../cordis.patch.yml'),
  ])
  const row = entries.find(entry => entry.name === '@deepseek-ai/dsh-bash-sandbox')
  expect(row).toBeDefined()
  return interpolate(ctx, row?.config ?? {}) as Record<string, unknown>
}

describe('a command run through the hive profile\'s shell', () => {
  it('reads a credential from the environment the mind spawned the turn with', async () => {
    process.env[CREDENTIAL] = 'lucent-credential-value'
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalBashExecutor, hiveShellConfig(ctx))

    const result = await ctx.shell.run(ctx.shell.resolve({ command: `printenv ${CREDENTIAL}` }))

    expect(result.exitCode).toBe(0)
    expect(result.stdout.text.trim()).toBe('lucent-credential-value')
  }, 30_000)
})
