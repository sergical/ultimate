import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { list, openProject } from '../server.ts'
import { projectHome } from '../../../lib/project-paths.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { temp } from '../../../test/helpers.ts'

it('lists every project with a folder, this one with its own counts, another instance’s from its status, one that fails without them, a stopped one with none, and not a stopped one whose folder is gone', async () => {
  const other = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ result: { busy: 2, questions: { count: 1 } } }))
  })
  await new Promise<void>((done) => other.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(other.address() as AddressInfo).port}`
  const userHome = await temp('ultimate-projects-')
  const stopped = await temp('ultimate-stopped-')
  const host = {
    userHome,
    projects: async () => [
      {
        name: 'down',
        root: '/w/down',
        current: false,
        running: { pid: 1, url: 'http://127.0.0.1:1' },
      },
      { name: 'stopped', root: stopped, current: false },
      { name: 'removed', root: '/w/removed', current: false },
      { name: 'unknown', current: false },
      { name: 'here', root: '/w/here', current: true },
      { name: 'other', root: '/w/other', current: false, running: { pid: 3, url } },
    ],
    system: () => ({ process: { url: 'http://127.0.0.1:4747' } }),
    conversations: () => [{ busy: true }, { busy: false }],
    need: () => ({ openQuestions: async () => [{}, {}, {}] }),
  } as unknown as ExtensionHost
  try {
    // Without a Tailscale registry nothing is on the tailnet.
    expect(await list(host, new AbortController().signal)).toEqual([
      { name: 'down', root: '/w/down', url: 'http://127.0.0.1:1', current: false },
      { name: 'stopped', root: stopped, current: false },
      {
        name: 'here',
        root: '/w/here',
        url: 'http://127.0.0.1:4747',
        current: true,
        busy: 1,
        questions: 3,
      },
      { name: 'other', root: '/w/other', url, current: false, busy: 2, questions: 1 },
    ])
  } finally {
    other.close()
  }
})

it('names the Tailscale port of each project the registry knows, for pages opened over the tailnet', async () => {
  const userHome = await temp('ultimate-projects-')
  await mkdir(join(userHome, '.ultimate'))
  await writeFile(
    join(userHome, '.ultimate/tailscale.json'),
    JSON.stringify({ ports: { '/work/here': { port: 4752 }, '/work/other': { port: 'x' } } }),
  )
  const host = {
    userHome,
    projects: async () => [
      { name: 'here', root: '/work/here', current: true },
      {
        name: 'other',
        root: '/work/other',
        current: false,
        running: { pid: 2, url: 'http://127.0.0.1:1' },
      },
      {
        name: 'unpublished',
        root: '/work/unpublished',
        current: false,
        running: { pid: 3, url: 'http://127.0.0.1:2' },
      },
    ],
    system: () => ({ process: { url: 'http://127.0.0.1:4747' } }),
    conversations: () => [],
    need: () => ({ openQuestions: async () => [] }),
  } as unknown as ExtensionHost
  const projects = await list(host, new AbortController().signal)
  // Only a numeric port counts; a project the registry does not hold, or holds without one, has none.
  expect(projects.map(({ name, tailnetPort }) => [name, tailnetPort])).toEqual([
    ['here', 4752],
    ['other', undefined],
    ['unpublished', undefined],
  ])
})

it('opens a project that already runs by its lock, without starting another, and refuses a path that is not a folder', async () => {
  const userHome = await realpath(await temp('ultimate-projects-'))
  const root = await realpath(await temp('ultimate-project-'))
  const home = projectHome(root, userHome)
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'ultimate.lock'), JSON.stringify({ pid: process.pid, port: 4791 }))
  const host = { ultimateRoot: '/nowhere', userHome }
  const signal = new AbortController().signal
  expect(await openProject(host, root, signal)).toEqual({ url: 'http://127.0.0.1:4791' })
  await expect(openProject(host, join(root, 'missing'), signal)).rejects.toThrow('No such folder')
  await expect(openProject(host, 'relative/path', signal)).rejects.toThrow('Not an absolute path')
})
