import { join } from 'node:path'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { expect, it, vi } from 'vitest'
import { hostDefault } from '../lib/agents.ts'
import { prepareHarness } from '../server/harness.ts'
import { temp } from './helpers.ts'

it('runs every default on the faux model, even with a machine login to a real provider', async () => {
  // #514: with the machine's AWS_PROFILE, automation runs and new conversations defaulted to Bedrock, the first model
  // with a login, and called it. The profile here is fake and its files do not exist, so nothing can authenticate.
  const root = await temp('ultimate-faux-default-')
  vi.stubEnv('AWS_PROFILE', 'ultimate-test-fake')
  vi.stubEnv('AWS_CONFIG_FILE', join(root, 'no-aws-config'))
  vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', join(root, 'no-aws-credentials'))
  try {
    const faux = fauxProvider()
    const host = await prepareHarness({ ultimateRoot: root, userHome: root, home: root, faux })
    await host.modelRuntime.refresh({ allowNetwork: false })
    const available = host.modelRuntime.getAvailableSnapshot()
    expect(available.some((model) => model.provider === 'amazon-bedrock')).toBe(true)
    expect((await hostDefault(host)).model).toEqual({
      provider: faux.getModel().provider,
      modelId: faux.getModel().id,
    })
  } finally {
    vi.unstubAllEnvs()
  }
})
