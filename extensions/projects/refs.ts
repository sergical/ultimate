/** Projects in the browser: every project Ultimate has opened on this machine, running or not, for the rail. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** One project: its name and folder, and while it runs its loopback URL and its live state when it answered. */
export type Project = {
  name: string
  /** Its folder. */
  root: string
  /** Its loopback address while an Ultimate runs it; absent while it is stopped. */
  url?: string
  /** The instance this page shows. */
  current: boolean
  /**
   * Its `origin` on GitHub, `<owner>/<repo>` as GitHub spells it, with its visibility when `gh` knew it; absent off
   * GitHub and until the first read finished.
   */
  repo?: { name: string; url: string; visibility?: 'public' | 'private' | 'internal' }
  /** Conversations running a turn now; absent when its `status` did not answer. */
  busy?: number
  /** Messages waiting on the user's answer; absent when its `status` did not answer. */
  questions?: number
  /** Its HTTPS port on the tailnet, when Tailscale registered one: where a page opened over the tailnet reaches it. */
  tailnetPort?: number
}

/** No arguments → every project on this machine, this one included, running or stopped, in project order. */
export const ListAction = actionRef<null, Project[]>('projects', 'list')

/**
 * `{ root }` → `{ url }`: the folder's Ultimate, started (`ultimate <root> --no-open`) unless it already runs, once it
 * listens. A new folder becomes a project. User-only: agents cannot start processes through it.
 */
export const OpenAction = actionRef<{ root: string }, { url: string }>('projects', 'open')

/** `{ pinned? }` → whether the rail stays open, shared by every instance on this machine; `pinned` sets it first. */
export const PinAction = actionRef<{ pinned?: boolean }, { pinned: boolean }>('projects', 'pin')
