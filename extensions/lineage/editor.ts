/** The editors the History page opens the project in, on the machine Ultimate runs on. Server-only. */
import type { JsonObject } from '@earendil-works/pi-durable'
import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { isMissing } from '../../lib/errors.ts'
import { readSettings, updateSettings, userSettingsPath } from '../../lib/settings.ts'
import type { Editor, EditorId } from './refs.ts'

/**
 * Each editor's macOS app and command names, in the order one is picked when the user has chosen none. On macOS only
 * the app counts, since a command can belong to another editor (Cursor installs a `code` command too).
 */
const EDITORS: (Editor & { app: string; commands: string[] })[] = [
  { id: 'zed', label: 'Zed', app: 'Zed', commands: ['zeditor', 'zed'] },
  { id: 'cursor', label: 'Cursor', app: 'Cursor', commands: ['cursor'] },
  { id: 'vscode', label: 'VS Code', app: 'Visual Studio Code', commands: ['code'] },
]

export const isEditorId = (value: unknown): value is EditorId =>
  EDITORS.some((editor) => editor.id === value)

const exists = (path: string, mode = constants.F_OK) =>
  access(path, mode).then(
    () => true,
    (error: unknown) => {
      if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'EACCES') return false
      throw error
    },
  )

/** How to start one installed editor: `open -a <app>` or a command on PATH. */
type Launcher = { command: string; args: string[] }
/** Where to look: the platform, the folders holding macOS apps, and PATH. */
type Machine = { platform: NodeJS.Platform; apps: string[]; path: string }

async function launcher(
  editor: (typeof EDITORS)[number],
  env: Machine,
): Promise<Launcher | undefined> {
  if (env.platform === 'darwin') {
    for (const folder of env.apps)
      if (await exists(join(folder, `${editor.app}.app`)))
        return { command: 'open', args: ['-a', editor.app] }
    return undefined
  }
  for (const command of editor.commands)
    for (const folder of env.path.split(delimiter).filter(Boolean))
      if (await exists(join(folder, command), constants.X_OK)) return { command, args: [] }
  return undefined
}

/**
 * The installed editors, in pick order, and the one Open uses: the user's `editor` setting when it is installed, else
 * the first installed. Only the user's own settings choose, never a project's, so a cloned repository cannot.
 */
export async function editors(
  userHome: string,
  env: Machine = {
    platform: process.platform,
    apps: ['/Applications', join(userHome, 'Applications')],
    path: process.env.PATH ?? '',
  },
) {
  const installed: (Editor & Launcher)[] = []
  for (const editor of EDITORS) {
    const found = await launcher(editor, env)
    if (found) installed.push({ id: editor.id, label: editor.label, ...found })
  }
  // Invalid settings JSON is reported where settings load; here it counts as unset.
  const settings: JsonObject = await readSettings(userSettingsPath(userHome)).catch(() => ({}))
  const setting = settings.editor
  const chosen = installed.find((editor) => editor.id === setting) ?? installed[0]
  return { installed, chosen }
}

/** Remember `id` as the user's editor in `~/.ultimate/settings.json`. */
export const chooseEditor = (userHome: string, id: EditorId) =>
  updateSettings(userSettingsPath(userHome), (settings) => {
    settings.editor = id
  })

/** Start `launcher` on `folder`, detached, once it has spawned. */
export const launch = ({ command, args }: Launcher, folder: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args, folder], { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
