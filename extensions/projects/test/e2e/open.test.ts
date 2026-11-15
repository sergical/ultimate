import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readOwner } from '../../../../lib/lock.ts'
import { projectHome } from '../../../../lib/project-paths.ts'
import { temp, until } from '../../../../test/helpers.ts'
import { openProject } from '../../server.ts'

const started: number[] = []
afterEach(async () => {
  for (const pid of started.splice(0)) {
    process.kill(pid, 'SIGTERM')
    await until(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    })
  }
})

it('starts a folder once for two concurrent opens, in the home of the given user home, and answers both with its URL', async () => {
  const userHome = await temp('ultimate-open-')
  const root = await temp('ultimate-open-project-')
  // A preview's user home differs from the OS home the supervisor would hash: the lock must land under the user home.
  vi.stubEnv('HOME', await temp('ultimate-open-os-'))
  vi.stubEnv('ULTIMATE_USER_HOME', userHome)
  const host = { ultimateRoot: resolve('.'), userHome }
  const signal = new AbortController().signal
  const [first, second] = await Promise.all([
    openProject(host, root, signal),
    openProject(host, root, signal),
  ])
  const owner = await readOwner(join(projectHome(root, userHome), 'ultimate.lock'))
  started.push(owner!.pid)
  expect(second).toEqual(first)
  expect(first.url).toBe(`http://127.0.0.1:${owner!.port}`)
  expect((await fetch(`${first.url}/`)).status).toBe(200)
})

it('quotes what a start that failed printed', async () => {
  const userHome = await temp('ultimate-open-')
  const root = await temp('ultimate-open-project-')
  const ultimateRoot = await temp('ultimate-open-broken-')
  await mkdir(join(ultimateRoot, 'bin'))
  await writeFile(
    join(ultimateRoot, 'bin/ultimate.ts'),
    "console.error('Cannot open project: EACCES'); process.exit(1)",
  )
  await expect(
    openProject({ ultimateRoot, userHome }, root, new AbortController().signal),
  ).rejects.toThrow('Cannot open project: EACCES')
  expect(await readFile(join(projectHome(root, userHome), 'start.log'), 'utf8')).toContain('EACCES')
})
