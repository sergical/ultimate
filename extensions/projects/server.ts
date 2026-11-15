/**
 * Projects: every project Ultimate has opened on this machine, from the host's project list (`host.projects()`), each
 * running one with its live counts from its own `status` action, for the rail's project switcher; and `open`, which
 * starts a folder's Ultimate.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, open as openFile, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineExtension } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { inBackground, meansNone } from '../../lib/errors.ts'
import { readJson, updateJson } from '../../lib/json-file.ts'
import { alive, readOwner } from '../../lib/lock.ts'
import { projectHome } from '../../lib/project-paths.ts'
import { githubRepo, readGithubRepo } from '../../lib/project-identity.ts'
import type { GithubRepo } from '../../lib/project-identity.ts'
import { postAction } from '../../lib/remote.ts'
import { pace } from '../../lib/timers.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { MessagesApi } from '../messages/api.ts'
import { ListAction, OpenAction, PinAction } from './refs.ts'
import type { Project } from './refs.ts'

/** How long the list waits for another instance's counts; a slower one shows without them until the next poll. */
const STATUS_WAIT = 1_500

type Counts = { busy: number; questions: number }

/** This instance's counts, as its own `status` action reports them. */
async function own(host: ExtensionHost): Promise<Counts> {
  return {
    busy: host.conversations().filter((conversation) => conversation.busy).length,
    questions: (await host.need(MessagesApi).openQuestions(context)).length,
  }
}

/** Another instance's counts from its `status` action, or nothing when it does not answer in time. */
async function counts(name: string, url: string, signal: AbortSignal) {
  const status = (await postAction(
    { url, label: name },
    'status',
    'status',
    {},
    AbortSignal.any([signal, AbortSignal.timeout(STATUS_WAIT)]),
  ).catch(meansNone)) as { busy?: unknown; questions?: { count?: unknown } } | undefined
  const busy = status?.busy
  const questions = status?.questions?.count
  return typeof busy === 'number' && typeof questions === 'number' ? { busy, questions } : {}
}

/**
 * Each project folder's GitHub repository, once known: read in the background on first sight (`git` here, then one
 * `gh` call for its visibility) and kept for the process, so a poll never waits on the network.
 */
const repos = new Map<string, GithubRepo | null>()
const reading = new Set<string>()
function repoOf(root: string | undefined) {
  if (!root) return undefined
  if (!repos.has(root) && !reading.has(root)) {
    reading.add(root)
    inBackground(
      (async () => {
        const key = await githubRepo(root)
        repos.set(root, key ? await readGithubRepo(key) : null)
        reading.delete(root)
      })(),
    )
  }
  return repos.get(root) ?? undefined
}

/**
 * A branch's checkout (`<home>/worktrees/<id>`, as previews run) is named for its project and that conversation,
 * `ultimate #586869`, as the sidebar heads it, so it shows and colours with its project rather than as a bare number.
 */
function checkoutName(name: string, root: string | undefined) {
  const worktree = /\/\.ultimate\/projects\/(.+)-[\da-f]{8}\/worktrees\/(\d+)$/.exec(root ?? '')
  return worktree ? `${worktree[1]} #${worktree[2]}` : name
}

/** Each project's port on the tailnet by its root, from the registry the tailscale extension keeps. */
async function tailnetPorts(host: ExtensionHost) {
  type Registry = { ports?: Record<string, { port?: unknown }> }
  const registry = await readJson<Registry>(
    join(host.userHome, '.ultimate', 'tailscale.json'),
    {},
  ).catch((): Registry => {
    // Without a readable registry nothing is published on the tailnet: instances are reached over loopback only.
    return {}
  })
  const ports: Record<string, number> = {}
  for (const [root, entry] of Object.entries(registry.ports ?? {}))
    if (typeof entry?.port === 'number') ports[root] = entry.port
  return ports
}

export async function list(host: ExtensionHost, signal: AbortSignal): Promise<Project[]> {
  const tailnet = await tailnetPorts(host)
  return Promise.all(
    (await host.projects()).flatMap(({ name, root, running, current }) => {
      // This server answers whether or not a supervisor wrote its port into the lock (a preview's has none).
      const url = current ? host.system().process.url : running?.url
      // A stopped project is listed by its folder, to start from the rail; without one, or once it is gone (a removed
      // checkout), there is nothing to start.
      if (!root || (!url && !existsSync(root))) return []
      return [
        (async () => {
          const repo = repoOf(root)
          return {
            name: checkoutName(name, root),
            root,
            ...(url && { url }),
            current,
            ...(repo && { repo: { name: repo.name, url: repo.url, visibility: repo.visibility } }),
            ...(tailnet[root] ? { tailnetPort: tailnet[root] } : {}),
            ...(current ? await own(host) : url ? await counts(name, url, signal) : {}),
          }
        })(),
      ]
    }),
  )
}

/** How long `open` waits for a started Ultimate to listen: its supervisor takes the lock and port within seconds. */
const START_WAIT = 30_000

/** The folder a path names, `~` for the home, refused unless it is an existing directory. */
async function folderOf(path: unknown) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('root must be a folder path')
  const expanded = path.trim().replace(/^~(?=$|\/)/, homedir())
  if (!isAbsolute(expanded)) throw new Error(`Not an absolute path: ${path}`)
  const folder = await realpath(expanded).catch(() => {
    throw new Error(`No such folder: ${path}`)
  })
  if (!(await stat(folder)).isDirectory()) throw new Error(`Not a folder: ${path}`)
  return folder
}

/** The URL of the Ultimate that holds `home`'s lock and listens, if one does. */
async function listening(home: string) {
  const owner = await readOwner(join(home, 'ultimate.lock')).catch(meansNone)
  return owner?.port && alive(owner.pid) ? `http://127.0.0.1:${owner.port}` : undefined
}

/**
 * Start `root`'s Ultimate, the way `ultimate <root>` does from a terminal, unless it already runs, and answer its URL
 * once it listens. It runs in its own process group with none of this server's `ULTIMATE_*` variables, so it outlives
 * this one and owns its own home; on any free port (`--port 0`), so its lock names no port until it listens. What it
 * prints before it is up goes to `<home>/start.log`, which a failure to start quotes.
 */
export async function openProject(
  host: Pick<ExtensionHost, 'ultimateRoot' | 'userHome'>,
  path: unknown,
  signal: AbortSignal,
) {
  const root = await folderOf(path)
  const home = projectHome(root, host.userHome)
  const running = await listening(home)
  if (running) return { url: running }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('ULTIMATE_') || name === 'ULTIMATE_USER_HOME',
    ),
  )
  await mkdir(home, { recursive: true })
  const logPath = join(home, 'start.log')
  const log = await openFile(logPath, 'w')
  const child = spawn(
    process.execPath,
    [join(host.ultimateRoot, 'bin/ultimate.ts'), root, '--no-open', '--port', '0'],
    {
      cwd: root,
      detached: true,
      env: { ...env, ULTIMATE_NO_OPEN: '1' },
      stdio: ['ignore', log.fd, log.fd],
    },
  )
  child.unref()
  let exited: number | null | undefined
  child.once('exit', (code) => (exited = code))
  child.once('error', () => (exited = -1))
  await log.close()
  const failed = async () =>
    new Error(
      `Ultimate did not start in ${root}: ${(await readFile(logPath, 'utf8').catch(meansNone))?.trim().slice(-800) || `exit ${exited}`}`,
    )
  const until = Date.now() + START_WAIT
  while (Date.now() < until) {
    const url = await listening(home)
    if (url) return { url }
    if (exited !== undefined) throw await failed()
    await pace(200, signal)
  }
  throw new Error(
    `Ultimate in ${root} did not listen within ${START_WAIT / 1000} s; see ${logPath}`,
  )
}

/** The rail's pin, one file for every instance on this machine, so jumping keeps the rail as it was. */
const pinPath = (host: ExtensionHost) => join(host.userHome, '.ultimate', 'projects-rail.json')
const readPin = async (path: string) => {
  const value = await readJson<{ pinned?: unknown }>(path, {})
  return { pinned: value.pinned === true }
}

export default function projects(host: ExtensionHost) {
  // Resolved where it is called; declared here so the catalogue lists it.
  host.need(MessagesApi)
  return defineExtension({ name: 'projects' })
}

/** The rail polls both: the trace counts their repeats instead of writing each. */
export const pollActions = ['list', 'pin']

/** Starting a process is the user's choice: agents reach other projects through `ultimate.tell`, never by starting one. */
export const userActions = ['open']

export const actions = {
  list: implementAction(ListAction, (_args, { host, signal }) => list(host, signal)),
  open: implementAction(OpenAction, (args, { host, signal }) =>
    openProject(
      host,
      args && typeof args === 'object' && !Array.isArray(args) ? args.root : undefined,
      signal,
    ),
  ),
  pin: implementAction(PinAction, async (args, { host }) => {
    const pinned =
      args && typeof args === 'object' && !Array.isArray(args) ? args.pinned : undefined
    if (pinned !== undefined && typeof pinned !== 'boolean')
      throw new Error('pinned must be a boolean')
    const path = pinPath(host)
    if (pinned !== undefined)
      await updateJson(path, readPin, (value) => {
        value.pinned = pinned
      })
    return readPin(path)
  }),
}
