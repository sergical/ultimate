import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { chooseEditor, editors } from '../editor.ts'

/** A home and a PATH folder holding executable stubs named `commands`. */
async function machine(commands: string[]) {
  const home = await mkdtemp(join(tmpdir(), 'editor-'))
  const bin = join(home, 'bin')
  await mkdir(bin)
  for (const command of commands) {
    await writeFile(join(bin, command), '')
    await chmod(join(bin, command), 0o755)
  }
  return {
    home,
    env: { platform: 'linux' as const, apps: [join(home, 'Applications')], path: bin },
  }
}

it('picks the first installed editor, Zed before Cursor before VS Code, unless the user chose one', async () => {
  const { home, env } = await machine(['code', 'cursor', 'zeditor'])
  const found = await editors(home, env)
  expect(found.installed.map((editor) => [editor.id, editor.command])).toEqual([
    ['zed', 'zeditor'],
    ['cursor', 'cursor'],
    ['vscode', 'code'],
  ])
  expect(found.chosen?.id).toBe('zed')

  await chooseEditor(home, 'vscode')
  expect((await editors(home, env)).chosen?.id).toBe('vscode')
})

it("on macOS counts only apps, never another editor's `code` command", async () => {
  const { home, env } = await machine(['code'])
  await mkdir(join(home, 'Applications/Cursor.app'), { recursive: true })
  const found = await editors(home, { ...env, platform: 'darwin' })
  expect(found.installed).toEqual([
    { id: 'cursor', label: 'Cursor', command: 'open', args: ['-a', 'Cursor'] },
  ])
})

it('ignores a chosen editor that is not installed, and finds none on a bare machine', async () => {
  const { home, env } = await machine(['cursor'])
  await chooseEditor(home, 'zed')
  expect((await editors(home, env)).chosen?.id).toBe('cursor')
  expect(await editors(home, { ...env, path: '' })).toEqual({ installed: [], chosen: undefined })
})
