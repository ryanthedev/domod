import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PunchFound, PunchItem, PunchKind, PunchOwner, PunchPr } from '../types'

const TODO_PANE = 'domod'
const NOTES_PANE = 'domod-notes'
const TOOL = 'mcp__domod__'
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const KEEP_DONE_FOR = 30 * DAY

const items = atom({ plugin: 'domod', key: 'items' } as const, [])
const notes = atom({ plugin: 'domod', key: 'notes' } as const, '')
const root = atom({ plugin: 'domod', key: 'root' } as const, '')
const found = atom({ plugin: 'domod', key: 'found' } as const, [])
const prs = atom({ plugin: 'domod', key: 'prs' } as const, {})

type $ = EngineInterface

const USAGE =
  '/todo opens the list · /todo <text> adds one for you · /todo done <id> · /todo snooze <id> 2h|3d|tomorrow|mon · /todo undo · /todo all'

const projectName = (path: string) => path.split('/').filter(Boolean).pop() ?? path

// One line, so an item can't break the list format it is sent to Claude in.
const clean = (text: unknown) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)

const ownerTag = (item: PunchItem) => {
  const who = item.owner === 'waiting' ? `waiting on ${item.waitingOn ?? 'someone'}` : item.owner
  return item.kind === 'decision' ? `${who}, decision` : who
}

const line = (item: PunchItem) =>
  `#${item.id} [${ownerTag(item)}]${item.isDone ? ' (done)' : ''} ${item.text}`

const isSnoozed = (item: PunchItem, now: number) => (item.snoozedUntil ?? 0) > now
const isOpen = (item: PunchItem, now: number) => !item.isDone && !isSnoozed(item, now)

const age = (now: number, since: number) => {
  const days = Math.floor((now - since) / DAY)
  if (days >= 1) return `${days}d`
  const hours = Math.floor((now - since) / HOUR)
  return hours >= 1 ? `${hours}h` : 'new'
}

const ageColor = (now: number, since: number) => {
  const days = (now - since) / DAY
  if (days >= 7) return 'error'
  if (days >= 3) return 'warning'
  return undefined
}

// "2h", "3d", "45m", "tomorrow", "mon".."sun": the time an item wakes, local time, 9am for days.
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
function wakeAt(now: number, when: string) {
  const span = /^(\d+)\s*(m|h|d)$/i.exec(when.trim())
  if (span) {
    const unit = { m: MINUTE, h: HOUR, d: DAY }[span[2]!.toLowerCase() as 'm' | 'h' | 'd']
    return now + Number(span[1]) * unit
  }

  const word = when.trim().toLowerCase().slice(0, 3)
  const morning = (daysAhead: number) => {
    const date = new Date(now)
    date.setDate(date.getDate() + daysAhead)
    date.setHours(9, 0, 0, 0)
    return date.getTime()
  }
  if (word === 'tom') return morning(1)
  const weekday = WEEKDAYS.indexOf(word)
  if (weekday >= 0) return morning(((weekday - new Date(now).getDay() + 6) % 7) + 1)

  return undefined
}

const shortWhen = (now: number, at: number) =>
  at - now < DAY ? `${Math.max(1, Math.round((at - now) / HOUR))}h` : `${Math.round((at - now) / DAY)}d`

// PRs an item names: GitHub URLs, owner/repo#n, and "PR 123" / "PRs 1, 2" in the item's own repo.
type PrRef = { key: string; number: number; repo?: string; cwd: string }
function prRefs(item: PunchItem): PrRef[] {
  const refs = new Map<string, PrRef>()
  const add = (number: number, repo?: string) => {
    const key = repo ? `${repo}#${number}` : `${item.root}|#${number}`
    refs.set(key, { key, number, repo, cwd: item.root })
  }

  for (const m of item.text.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)) add(Number(m[2]), m[1])
  for (const m of item.text.matchAll(/(?:^|\s)([\w.-]+\/[\w.-]+)#(\d+)/g)) add(Number(m[2]), m[1])
  for (const m of item.text.matchAll(/\bPRs?\s+((?:#?\d+(?:\s*(?:,|and|&)\s*)?)+)/gi)) {
    for (const n of m[1]!.matchAll(/\d+/g)) add(Number(n[0]))
  }

  return [...refs.values()]
}

// Writes queue behind each other, so two changes in one session never read the same old list.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work)
  queue = run.catch(() => undefined)
  return run
}

const loadItems = async ($: $) => ((await $.store.get('items')) as PunchItem[] | undefined) ?? []
const loadNotes = async ($: $, path: string) =>
  ((await $.store.get(`notes:${path}`)) as string | undefined) ?? ''

// Open counts per project root, for the status line script to read.
async function writeCounts($: $, list: PunchItem[]) {
  const home = await $.env.get('HOME')
  if (!home) return

  const now = await $.clock.now()
  const counts: Record<string, Record<PunchOwner, number>> = {}
  for (const item of list) {
    if (!isOpen(item, now)) continue
    const entry = (counts[item.root] ??= { me: 0, claude: 0, waiting: 0 })
    entry[item.owner] = (entry[item.owner] ?? 0) + 1
  }
  await $.fs.write(`${home}/.claude/domod/counts.json`, JSON.stringify(counts))
}

// Every change starts from the store, not this session's copy: other sessions write it too.
function mutate($: $, change: (list: PunchItem[]) => PunchItem[]) {
  return serial(async () => {
    const changed = change(await loadItems($))
    await $.store.set('items', changed)
    await update($, items, () => changed)
    await writeCounts($, changed)
    return changed
  })
}

function changeNotes($: $, change: (text: string) => string) {
  return serial(async () => {
    const path = await read($, root)
    const changed = change(await loadNotes($, path))
    await $.store.set(`notes:${path}`, changed)
    await update($, notes, () => changed)
    return changed
  })
}

const appendNote = ($: $, text: string) =>
  changeNotes($, current => (current ? `${current}\n${text}` : text))

type NewItem = { text: string; owner: PunchOwner; kind?: PunchKind; waitingOn?: string }

async function addItem($: $, fresh: NewItem) {
  const body = clean(fresh.text)
  if (!body) return undefined

  const here = await read($, root)
  const createdAt = await $.clock.now()
  const waitingOn = fresh.owner === 'waiting' ? clean(fresh.waitingOn) || 'someone' : undefined
  let added: PunchItem | undefined
  await mutate($, list => {
    const id = list.reduce((top, item) => Math.max(top, item.id), 0) + 1
    added = { id, text: body, owner: fresh.owner, isDone: false, root: here, createdAt, doneAt: null }
    if (fresh.kind === 'decision') added.kind = 'decision'
    if (waitingOn) added.waitingOn = waitingOn
    return [...list, added]
  })

  return added
}

async function editItem($: $, id: number, edit: (item: PunchItem) => PunchItem) {
  let edited: PunchItem | undefined
  await mutate($, list =>
    list.map(item => {
      if (item.id !== id) return item
      edited = edit(item)
      return edited
    }),
  )

  return edited
}

async function setDone($: $, id: number, isDone: boolean, doneBy?: string) {
  const now = await $.clock.now()

  return editItem($, id, item => {
    if (item.isDone === isDone) return item
    const { doneBy: _, ...rest } = item
    return isDone ? { ...rest, isDone, doneAt: now, ...(doneBy ? { doneBy } : {}) } : { ...rest, isDone, doneAt: null }
  })
}

// Pulls in what other sessions wrote, and follows the session to a new project root.
async function sync($: $) {
  const here = await $.session.root()
  const fresh = await loadItems($)
  const freshNotes = await loadNotes($, here)

  if ((await read($, root)) !== here) await update($, root, () => here)
  if (JSON.stringify(fresh) !== JSON.stringify(await read($, items))) {
    await update($, items, () => fresh)
  }
  if (freshNotes !== (await read($, notes))) await update($, notes, () => freshNotes)
}

async function openHere($: $) {
  const here = await read($, root)
  const now = await $.clock.now()

  return (await read($, items)).filter(item => isOpen(item, now) && item.root === here)
}

const withProject = (item: PunchItem, here: string) =>
  item.root === here ? line(item) : `${line(item)}  (${projectName(item.root)})`

const OWNER_SCHEMA = { type: 'string', enum: ['me', 'claude', 'waiting'] }

const TOOLS = [
  {
    name: 'todo_add',
    description:
      "Add an item to domod, the person's todo list that lasts across sessions. owner 'me' is the person's own action; 'claude' is work Claude agreed to do later; 'waiting' is blocked on someone else (give waitingOn). kind 'decision' is a call only the person can make (go/no-go, pick an option).",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'One line, self-contained: name the ticket, PR or system.' },
        owner: OWNER_SCHEMA,
        kind: { type: 'string', enum: ['task', 'decision'] },
        waitingOn: { type: 'string', description: "Who it waits on, when owner is 'waiting'." },
      },
      required: ['text', 'owner'],
    },
  },
  {
    name: 'todo_done',
    description: 'Mark a domod item done by its id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    },
  },
  {
    name: 'todo_update',
    description: "Change a domod item's text, owner or who it waits on (for example, the person hands an item to Claude).",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        text: { type: 'string' },
        owner: OWNER_SCHEMA,
        waitingOn: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'todo_list',
    description: 'List domod items for this project, or every project.',
    inputSchema: {
      type: 'object',
      properties: {
        allProjects: { type: 'boolean' },
        includeDone: { type: 'boolean' },
      },
    },
  },
  {
    name: 'note_append',
    description: "Append a line to this project's notepad, which the person reads in the domod notes pane.",
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
] as const

const INSTRUCTIONS = [
  '# domod',
  `The person keeps a todo list that lasts across sessions. Tools: ${TOOL}todo_add, todo_done, todo_update, todo_list, note_append. The open items for this project arrive beside their prompts as "domod (open items)".`,
  '- When a reply ends with actions only the person can take or decisions only they can make, record each one with todo_add owner "me" (kind "decision" for a go/no-go or a choice), unless it is already open.',
  '- When something is blocked on a third person, use owner "waiting" with waitingOn.',
  '- When the person asks you to do something later, or you defer a task, record it with owner "claude".',
  '- Mark an item done with todo_done as soon as it is finished, by you or (as the person tells you) by them.',
].join('\n')

// Phrases that mark a reply as asking something of the person; the harvester runs only then.
const ASKS = /what you need to do|your turn|you(?:'ll)? need to|need you to|needs? your|decide|decision|go\/no-go|waiting on|blocked on|please (?:run|review|approve|merge|confirm)|can you /i

const HARVEST_SYSTEM = [
  'You read one message from an AI coding assistant (or a teammate) to a person and list the action items it leaves open.',
  'An action item is something only the person can do or decide, something blocked on a named third person, or work the assistant explicitly deferred to later.',
  'Leave out work the assistant already did, background explanation, and anything on the ALREADY OPEN list.',
  'Return only a JSON array, at most 8 entries, each {"text": string, "owner": "me" | "claude" | "waiting", "kind": "task" | "decision", "waitingOn"?: string}.',
  'text is one self-contained line in the imperative, naming tickets, PRs and systems exactly. kind "decision" is a go/no-go or a choice between options. Return [] when there is nothing.',
].join('\n')

function parseFound(reply: string, source: string): PunchFound[] {
  const start = reply.indexOf('[')
  const end = reply.lastIndexOf(']')
  if (start < 0 || end <= start) return []

  try {
    const rows = JSON.parse(reply.slice(start, end + 1)) as unknown[]
    return rows.flatMap((row, at) => {
      const entry = row as { text?: unknown; owner?: unknown; kind?: unknown; waitingOn?: unknown }
      const text = clean(entry.text)
      if (!text) return []
      const owner: PunchOwner = entry.owner === 'claude' || entry.owner === 'waiting' ? entry.owner : 'me'
      const kind: PunchKind = entry.kind === 'decision' ? 'decision' : 'task'
      const waitingOn = owner === 'waiting' ? clean(entry.waitingOn) || undefined : undefined
      return [{ key: `${source}-${at}-${text.slice(0, 24)}`, text, owner, kind, waitingOn, source }]
    })
  } catch {
    return []
  }
}

const sameText = (a: string, b: string) => {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const x = norm(a)
  const y = norm(b)
  return x === y || (x.length > 20 && y.includes(x)) || (y.length > 20 && x.includes(y))
}

// The person's switches (userConfig), set each time the module loads.
let flags = {
  runNow: true,
  decisions: true,
  waiting: true,
  snooze: true,
  notify: true,
  autoClose: true,
  harvestModel: 'haiku',
}

// Draft of the notes field, kept so a redraw mid-typing doesn't drop it.
let notesDraft: string | undefined
// What the model was last told, so the list rides along only when it changes.
let lastSent: string | undefined
// Messages from teammates since the last harvest.
let inbound: { source: string; text: string }[] = []

function notify($: $, text: string) {
  if (flags.notify) void $.ui.notify(text, { title: 'domod' })
}

function runItem($: $, item: PunchItem) {
  return $.prompt.submit({
    text: `Work on domod item #${item.id}: ${item.text}\nWhen it is finished, mark it done with todo_done.`,
  })
}

async function accept($: $, entry: PunchFound, owner: PunchOwner, shouldRun = false) {
  await update($, found, list => list.filter(one => one.key !== entry.key))
  const item = await addItem($, {
    text: entry.text,
    owner: owner === 'waiting' && !flags.waiting ? 'me' : owner,
    kind: flags.decisions ? entry.kind : 'task',
    waitingOn: entry.waitingOn,
  })
  if (item && shouldRun) await runItem($, item)
}

async function acceptAll($: $, pending: readonly PunchFound[]) {
  for (const one of pending) await accept($, one, one.owner)
}

async function decide($: $, id: number, answer: 'go' | 'no-go') {
  const now = await $.clock.now()
  await editItem($, id, one => ({
    ...one,
    isDone: true,
    doneAt: now,
    doneBy: `you: ${answer}`,
    decision: { answer, at: now, isSent: false },
  }))
}

async function snoozeItem($: $, id: number, when: string) {
  const at = wakeAt(await $.clock.now(), when)
  if (at === undefined) return undefined
  return editItem($, id, item => ({ ...item, snoozedUntil: at }))
}

async function setOwner($: $, id: number, owner: PunchOwner) {
  return editItem($, id, item => ({ ...item, owner }))
}

// Brings back items whose snooze ran out; this session notifies only for the ones it woke.
async function wakeSnoozed($: $) {
  const now = await $.clock.now()
  const woken: PunchItem[] = []
  const current = await read($, items)
  if (!current.some(item => item.snoozedUntil && item.snoozedUntil <= now)) return

  await mutate($, list =>
    list.map(item => {
      if (!item.snoozedUntil || item.snoozedUntil > now) return item
      const awake = { ...item, snoozedUntil: null }
      if (!item.isDone) woken.push(awake)
      return awake
    }),
  )
  for (const item of woken) notify($, `Back on your list: #${item.id} ${item.text}`)
}

// Closes open items naming a PR; returns what it closed.
async function closeForPr($: $, match: (ref: PrRef) => boolean, doneBy: string) {
  const now = await $.clock.now()
  const closed: PunchItem[] = []
  await mutate($, list =>
    list.map(item => {
      if (item.isDone || !prRefs(item).some(match)) return item
      const done = { ...item, isDone: true, doneAt: now, doneBy }
      closed.push(done)
      return done
    }),
  )
  if (closed.length) await $.store.set('undo', closed.map(item => item.id))
  return closed
}

async function pollPrs($: $) {
  const now = await $.clock.now()
  const refs = new Map<string, PrRef>()
  for (const item of await read($, items)) {
    if (!isOpen(item, now)) continue
    for (const ref of prRefs(item)) refs.set(ref.key, ref)
  }

  const seen = await read($, prs)
  const fresh: Record<string, PunchPr> = {}
  for (const ref of [...refs.values()].slice(0, 20)) {
    try {
      const argv = ['gh', 'pr', 'view', String(ref.number), '--json', 'state,reviewDecision,statusCheckRollup,url']
      if (ref.repo) argv.push('-R', ref.repo)
      const ran = await $.process.run(argv, { cwd: ref.cwd, timeoutMs: 20000 })
      if (ran.exitCode !== 0) continue
      const view = JSON.parse(ran.stdout) as {
        state: string
        reviewDecision: string | null
        url: string
        statusCheckRollup: { conclusion?: string; status?: string; state?: string }[] | null
      }
      const checks = view.statusCheckRollup ?? []
      const isFailing = checks.some(c =>
        ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(c.conclusion ?? c.state ?? ''),
      )
      const isPending = checks.some(c => (c.status && c.status !== 'COMPLETED') || c.state === 'PENDING')
      fresh[ref.key] = {
        state: view.state === 'MERGED' ? 'merged' : view.state === 'CLOSED' ? 'closed' : 'open',
        review: view.reviewDecision ?? '',
        checks: checks.length === 0 ? 'none' : isFailing ? 'failing' : isPending ? 'pending' : 'passing',
        url: view.url,
      }
    } catch {
      // gh missing a repo, a network blip: keep the last badge.
      if (seen[ref.key]) fresh[ref.key] = seen[ref.key]!
    }
  }
  await update($, prs, () => fresh)

  if (!flags.autoClose) return
  const merged = Object.entries(fresh).filter(([key, pr]) => pr.state === 'merged' && seen[key]?.state !== 'merged')
  for (const [key] of merged) {
    const closed = await closeForPr($, ref => ref.key === key, 'merged on GitHub')
    for (const item of closed) notify($, `PR merged, closed #${item.id} ${item.text}`)
  }
}

async function harvest($: $, texts: { source: string; text: string }[]) {
  const here = await read($, root)
  const now = await $.clock.now()
  const current = await loadItems($)
  const open = current.filter(item => isOpen(item, now) && item.root === here).map(line).join('\n') || '(none)'
  const pending = await read($, found)
  const results: PunchFound[] = []

  for (const { source, text } of texts) {
    const reply = await $.model.complete({
      model: flags.harvestModel,
      system: HARVEST_SYSTEM,
      prompt: `ALREADY OPEN:\n${open}\n\nMESSAGE (from ${source}):\n${text.slice(0, 12000)}`,
      maxTokens: 1500,
      timeoutMs: 60000,
    })
    if (!reply.isAnswered) continue
    results.push(...parseFound(reply.text, source))
  }

  const fresh = results.filter(
    entry =>
      !current.some(item => !item.isDone && sameText(item.text, entry.text)) &&
      !pending.some(one => sameText(one.text, entry.text)),
  )
  if (fresh.length === 0) return
  await update($, found, list => [...list, ...fresh].slice(-20))
  $.ui.toast(`domod found ${fresh.length} action item${fresh.length === 1 ? '' : 's'}: sort them above the prompt`)
}

export const register: Register = (on, options) => {
  const flag = (key: string) => options[key] !== false
  const hasRunNow = flag('runNow')
  const hasDecisions = flag('decisions')
  const hasWaiting = flag('waitingOn')
  const hasSnooze = flag('snooze')
  const hasAutoClose = flag('autoClose')
  const pollMinutes = typeof options.prPollMinutes === 'number' && options.prPollMinutes > 0 ? options.prPollMinutes : 10
  flags = {
    runNow: hasRunNow,
    decisions: hasDecisions,
    waiting: hasWaiting,
    snooze: hasSnooze,
    notify: flag('notifications'),
    autoClose: hasAutoClose,
    harvestModel: typeof options.harvestModel === 'string' ? options.harvestModel : 'haiku',
  }

  on('session.start', async ($, e, next) => {
    const now = await $.clock.now()
    await sync($)
    await mutate($, list =>
      list.filter(item => !item.isDone || now - (item.doneAt ?? now) < KEEP_DONE_FOR),
    )
    $.clock.every(5000, () => void sync($))
    if (hasSnooze) $.clock.every(MINUTE, () => void wakeSnoozed($))

    if (flag('prStatus')) {
      const auth = await $.process.run(['gh', 'auth', 'status'], { timeoutMs: 10000 }).catch(() => undefined)
      if (auth?.exitCode === 0) {
        $.clock.after(3000, () => void pollPrs($))
        $.clock.every(pollMinutes * MINUTE, () => void pollPrs($))
      } else {
        $.ui.toast('domod: PR badges are off because gh is missing or not signed in')
      }
    }

    for (const tool of TOOLS) {
      await $.tool.register({ ...tool, isDeferred: false })
    }
    await $.command.register({
      name: 'todo',
      description: 'domod: open the pane, or /todo <text>, done <id>, snooze <id> <when>, undo, all',
      argumentHint: '[text | done <id> | snooze <id> <when> | undo | all]',
    })
    await $.command.register({
      name: 'note',
      description: 'Notepad: open the pane, or /note <text> to append a line',
      argumentHint: '[text]',
    })

    return next(e)
  })

  on('tool.call', { tool: 'mcp__domod__todo_add' }, async ($, e) => {
    const input = e as unknown as { text?: string; owner?: string; kind?: string; waitingOn?: string }
    const owner: PunchOwner =
      input.owner === 'claude' ? 'claude' : input.owner === 'waiting' && hasWaiting ? 'waiting' : 'me'
    const item = await addItem($, {
      text: input.text ?? '',
      owner,
      kind: input.kind === 'decision' && hasDecisions ? 'decision' : 'task',
      waitingOn: input.waitingOn,
    })

    return { result: item ? `Added ${line(item)}` : 'Nothing added: the text was empty.' }
  })

  on('tool.call', { tool: 'mcp__domod__todo_done' }, async ($, e) => {
    const item = await setDone($, Number((e as unknown as { id?: number }).id), true, 'Claude')

    return { result: item ? `Done: ${withProject(item, await read($, root))}` : 'No item has that id.' }
  })

  on('tool.call', { tool: 'mcp__domod__todo_update' }, async ($, e) => {
    const input = e as unknown as { id?: number; text?: string; owner?: string; waitingOn?: string }
    const item = await editItem($, Number(input.id), current => {
      const owner: PunchOwner =
        input.owner === 'claude' || input.owner === 'me' || (input.owner === 'waiting' && hasWaiting)
          ? input.owner
          : current.owner
      const waitingOn = owner === 'waiting' ? clean(input.waitingOn) || current.waitingOn || 'someone' : undefined
      const { waitingOn: _, ...rest } = current
      return { ...rest, text: clean(input.text) || current.text, owner, ...(waitingOn ? { waitingOn } : {}) }
    })

    return { result: item ? `Updated ${withProject(item, await read($, root))}` : 'No item has that id.' }
  })

  on('tool.call', { tool: 'mcp__domod__todo_list' }, async ($, e) => {
    const input = e as unknown as { allProjects?: boolean; includeDone?: boolean }
    const here = await read($, root)
    const now = await $.clock.now()
    const list = (await loadItems($)).filter(
      item =>
        (input.includeDone || !item.isDone) && (input.allProjects || item.root === here),
    )

    return {
      result:
        list
          .map(item => {
            const text = withProject(item, here)
            return isSnoozed(item, now) ? `${text}  (snoozed ${shortWhen(now, item.snoozedUntil!)})` : text
          })
          .join('\n') || 'The domod is empty.',
    }
  })

  on('tool.call', { tool: 'mcp__domod__note_append' }, async ($, e) => {
    const text = String((e as unknown as { text?: string }).text ?? '').trim()
    if (!text) return { result: 'Nothing appended: the text was empty.' }
    await appendNote($, text)

    return { result: 'Appended to the notepad.' }
  })

  on('command.run', { command: 'todo' }, async ($, e) => {
    const args = e.args.trim()
    const [word = '', ...rest] = args.split(/\s+/)
    const keyword = word.toLowerCase()
    const here = await read($, root)

    if (args === '') {
      const { isPlaced } = await $.ui.open({ id: TODO_PANE, title: 'domod' })
      return { text: isPlaced ? 'domod opened.' : 'domod will show once the terminal is wide enough.' }
    }

    if (keyword === 'done') {
      const id = Number(rest.join(' ').replace(/^#/, ''))
      if (rest.length !== 1 || !Number.isInteger(id)) return { text: `Usage: /todo done <id>. ${USAGE}` }
      const item = await setDone($, id, true, 'you')
      return { text: item ? `Done: ${withProject(item, here)}` : `No item #${id}.` }
    }

    if (keyword === 'snooze' && hasSnooze) {
      const id = Number((rest[0] ?? '').replace(/^#/, ''))
      const item = Number.isInteger(id) && rest[1] ? await snoozeItem($, id, rest.slice(1).join(' ')) : undefined
      if (!item) return { text: 'Usage: /todo snooze <id> 2h|3d|tomorrow|mon (and the id must exist)' }
      return { text: `Snoozed #${item.id} for ${shortWhen(await $.clock.now(), item.snoozedUntil!)}: ${item.text}` }
    }

    if (keyword === 'undo' && rest.length === 0) {
      const ids = ((await $.store.get('undo')) as number[] | undefined) ?? []
      if (ids.length === 0) return { text: 'Nothing to undo.' }
      for (const id of ids) await setDone($, id, false)
      await $.store.delete('undo')
      return { text: `Reopened ${ids.map(id => `#${id}`).join(', ')}.` }
    }

    if (keyword === 'all' && rest.length === 0) {
      const now = await $.clock.now()
      const open = (await read($, items)).filter(item => isOpen(item, now))
      return { text: open.map(item => withProject(item, here)).join('\n') || 'Nothing open anywhere.' }
    }

    if (keyword === 'help' || keyword === '?') return { text: USAGE }

    const item = await addItem($, { text: args, owner: 'me' })
    return { text: item ? `Added ${line(item)}` : USAGE }
  })

  on('command.run', { command: 'note' }, async ($, e) => {
    const args = e.args.trim()

    if (args === '') {
      const { isPlaced } = await $.ui.open({ id: NOTES_PANE, title: 'Notes' })
      return { text: isPlaced ? 'Notepad opened.' : 'Notepad will show once the terminal is wide enough.' }
    }

    await appendNote($, args)
    return { text: 'Noted.' }
  })

  // Standing instructions only: text that changes here would rewrite the prompt cache.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.includes(`${TOOL}todo_add`)) return composed

    return {
      sections: [...composed.sections, { id: 'domod:instructions', text: INSTRUCTIONS, scope: 'session' }],
    }
  })

  // The live list (and decisions not yet passed on) ride beside the person's prompt, only when changed.
  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e)

    await sync($)
    const here = await read($, root)
    const decided = (await read($, items)).filter(item => item.decision && !item.decision.isSent && item.root === here)
    const context: string[] = []

    if (decided.length) {
      const said = decided.map(item => `#${item.id} ${item.text}: ${item.decision!.answer.toUpperCase()}`).join('\n')
      context.push(`domod decisions the person just recorded:\n${said}`)
      const ids = new Set(decided.map(item => item.id))
      await mutate($, list =>
        list.map(item => (ids.has(item.id) && item.decision ? { ...item, decision: { ...item.decision, isSent: true } } : item)),
      )
    }

    const open = (await openHere($)).slice(0, 60)
    const listed = open.length ? open.map(line).join('\n') : '(nothing open)'
    const text = `domod (open items for ${projectName(here)}):\n${listed}`
    if (text !== lastSent && !(lastSent === undefined && open.length === 0)) {
      lastSent = text
      context.push(text)
    }

    return context.length ? next({ ...e, context: [...(e.context ?? []), ...context] }) : next(e)
  }).catch(($, e, next) => next(e))

  if (flag('harvest')) {
    if (flag('harvestTeammates')) {
      // Messages other sessions and teammates deliver: kept for the next harvest.
      on('session.append', async ($, e, next) => {
        const kind = (e.origin as { kind?: string }).kind
        if (!e.agentId && e.door === 'delivery' && kind !== 'task-notification') {
          const content = e.message.content
          const text = typeof content === 'string'
            ? content
            : (content as readonly { type: string; text?: string }[])
                .filter(block => block.type === 'text')
                .map(block => block.text ?? '')
                .join('\n')
          if (ASKS.test(text)) inbound = [...inbound, { source: 'a teammate', text }].slice(-5)
        }
        return next(e)
      }).catch(($, e, next) => next(e))
    }

    on('turn.complete', async ($, e, next) => {
      const done = await next(e)
      if (e.agentId || e.reason !== 'answer') return done

      const texts = [...inbound]
      inbound = []
      if (ASKS.test(e.answer)) texts.push({ source: 'Claude', text: e.answer })
      if (texts.length) void harvest($, texts).catch(() => undefined)

      return done
    })
  }

  if (hasAutoClose) {
    // Observes Claude's shell commands; a merge or close of a PR an item names closes that item.
    on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
      const ran = await next(e)
      if (ran.deny !== undefined || ran.isError) return ran

      const match = /(?:^|&&|;|\|\||\n)\s*gh\s+pr\s+(merge|close)\b([^\n;&|]*)/.exec(e.command)
      if (!match) return ran
      const [, verb, tail = ''] = match
      const url = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(tail)
      const repoFlag = /(?:-R|--repo)\s+([\w.-]+\/[\w.-]+)/.exec(tail)?.[1]
      const number = Number(url?.[2] ?? /(?:^|\s)#?(\d+)\b/.exec(tail)?.[1])
      if (!Number.isInteger(number) || number <= 0) return ran
      const repo = url?.[1] ?? repoFlag

      const closed = await closeForPr(
        $,
        ref => ref.number === number && (!repo || !ref.repo || ref.repo === repo),
        `auto: gh pr ${verb} ${number}`,
      )
      if (closed.length) {
        $.ui.toast(`Closed ${closed.map(item => `#${item.id}`).join(', ')} after gh pr ${verb}. /todo undo reopens.`)
      }
      return ran
    }).catch(($, e, next) => next(e))
  }

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const pending = await read($, found)

    if (pending.length) {
      const [first, ...more] = pending
      const entry = first!
      const suggested =
        entry.owner === 'waiting' ? `waiting on ${entry.waitingOn ?? 'someone'}` : entry.owner === 'claude' ? 'Claude' : 'you'

      return (
        <Box flexDirection="column">
          <Text>
            <Text color="warning">domod found {pending.length}</Text>
            <Text dimColor> from {entry.source} · suggested: {suggested}{entry.kind === 'decision' ? ', decision' : ''}</Text>
          </Text>
          <Text wrap="truncate-end">▸ {entry.text}</Text>
          <Box flexDirection="row">
            <Button key="found-me" plain hotkey="y" label="you" onPress={() => void accept($, entry, 'me')} />
            <Text>  </Text>
            <Button key="found-claude" plain hotkey="c" label="Claude" onPress={() => void accept($, entry, 'claude')} />
            {hasRunNow && <Text>  </Text>}
            {hasRunNow && (
              <Button key="found-run" plain hotkey="r" label="run now" onPress={() => void accept($, entry, 'claude', true)} />
            )}
            {hasWaiting && entry.owner === 'waiting' && <Text>  </Text>}
            {hasWaiting && entry.owner === 'waiting' && (
              <Button key="found-wait" plain hotkey="w" label="waiting" onPress={() => void accept($, entry, 'waiting')} />
            )}
            <Text>  </Text>
            <Button
              key="found-drop"
              plain
              hotkey="x"
              label="drop"
              onPress={() => void update($, found, list => list.filter(one => one.key !== entry.key))}
            />
            <Text>  </Text>
            <Button
              key="found-all"
              plain
              hotkey="a"
              label={`accept all ${pending.length} as suggested`}
              onPress={() => void acceptAll($, pending)}
            />
          </Box>
          {more.length > 0 && (
            <Text dimColor wrap="truncate-end">
              next: {more.map(one => one.text).join(' · ')}
            </Text>
          )}
        </Box>
      )
    }

    const open = await openHere($)
    const mine = open.filter(item => item.owner === 'me')
    if (mine.length === 0) return next(e)

    const others = open.length - mine.length
    const oldest = mine.reduce((a, b) => (b.createdAt < a.createdAt ? b : a))
    const now = await $.clock.now()

    return (
      <Box flexDirection="row">
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            <Text color="warning">{mine.length} for you</Text>
            <Text dimColor>{others ? `, ${others} other` : ''} · oldest: </Text>
            {oldest.text}{' '}
            <Text color={ageColor(now, oldest.createdAt)} dimColor={!ageColor(now, oldest.createdAt)}>
              {age(now, oldest.createdAt)}
            </Text>
          </Text>
        </Box>
        <Text> </Text>
        <Button key="done-oldest" label="Done" onPress={() => void setDone($, oldest.id, true, 'you')} />
        <Button
          key="open"
          label="Open"
          onPress={() => void $.ui.open({ id: TODO_PANE, title: 'domod', focus: true })}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: TODO_PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    const here = await read($, root)
    const now = await $.clock.now()
    const badges = await read($, prs)
    const all = (await read($, items)).filter(item => item.root === here)
    const open = all.filter(item => isOpen(item, now))
    const mine = open.filter(item => item.owner === 'me')
    const claudes = open.filter(item => item.owner === 'claude')
    const waiting = open.filter(item => item.owner === 'waiting')
    const snoozed = all.filter(item => !item.isDone && isSnoozed(item, now))
    const recent = all
      .filter(item => item.isDone)
      .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
      .slice(0, 5)
    // Digits 1-9 toggle the first nine open rows while the pane has the keys.
    const hotkeys = new Map([...mine, ...claudes, ...waiting].slice(0, 9).map((item, at) => [item.id, String(at + 1)]))

    const prBadges = (item: PunchItem) =>
      prRefs(item).flatMap(ref => {
        const pr = badges[ref.key]
        if (!pr) return []
        const [label, color] =
          pr.state === 'merged'
            ? ['merged', 'success']
            : pr.state === 'closed'
              ? ['closed', undefined]
              : pr.checks === 'failing'
                ? ['checks ✗', 'error']
                : pr.review === 'CHANGES_REQUESTED'
                  ? ['changes', 'warning']
                  : pr.review === 'APPROVED'
                    ? ['approved', 'success']
                    : pr.checks === 'pending'
                      ? ['checks …', undefined]
                      : ['open', undefined]
        return [
          <Text key={`pr-${item.id}-${ref.key}`} color={color} dimColor={!color}>
            {' '}#{ref.number} {label}
          </Text>,
        ]
      })

    const action = (key: string, label: string, onPress: () => void) => [
      <Text key={`gap-${key}`}> </Text>,
      <Button key={key} plain label={label} onPress={onPress} />,
    ]

    const row = (item: PunchItem) => {
      const color = item.isDone ? undefined : ageColor(now, item.createdAt)
      const hotkey = hotkeys.get(item.id)
      const isDecision = item.kind === 'decision' && hasDecisions && !item.isDone

      const actions = item.isDone
        ? []
        : [
            ...(isDecision ? action(`go-${item.id}`, 'go', () => void decide($, item.id, 'go')) : []),
            ...(isDecision ? action(`nogo-${item.id}`, 'no-go', () => void decide($, item.id, 'no-go')) : []),
            ...(item.owner === 'claude' && hasRunNow ? action(`run-${item.id}`, '▶ run', () => void runItem($, item)) : []),
            ...(item.owner === 'me'
              ? action(`swap-${item.id}`, '→Claude', () => void setOwner($, item.id, 'claude'))
              : action(`swap-${item.id}`, '→me', () => void setOwner($, item.id, 'me'))),
            ...(hasSnooze ? action(`zz-${item.id}`, 'zz', () => void snoozeItem($, item.id, 'tomorrow')) : []),
          ]
      const detail = item.isDone
        ? `#${item.id}${item.doneBy ? ` · ${item.doneBy}` : ''}`
        : `#${item.id} ${age(now, item.createdAt)}${item.owner === 'waiting' ? ` · ${item.waitingOn ?? 'someone'}` : ''}`

      return (
        <Box key={`row-${item.id}`} flexDirection="row">
          <Box flexGrow={1} flexShrink={1}>
            <Button
              key={`item-${item.id}`}
              plain
              hotkey={hotkey}
              onPress={() => void setDone($, item.id, !item.isDone, 'you')}
            >
              {hotkey ? '' : '   '}
              {item.isDone ? '☑ ' : isDecision ? '◇ ' : '☐ '}
              <Text dimColor={item.isDone}>{item.text}</Text>{' '}
              <Text color={color} dimColor={!color}>
                {detail}
              </Text>
            </Button>
            {prBadges(item)}
          </Box>
          {actions}
        </Box>
      )
    }
    const group = (title: string, list: PunchItem[], tone: string | undefined) => (
      <Box key={`group-${title}`} flexDirection="column" marginBottom={1}>
        <Text bold color={tone}>
          {title} <Text dimColor>{list.length}</Text>
        </Text>
        {list.length === 0 ? <Text dimColor>  Nothing open.</Text> : list.map(row)}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {projectName(here)} · 1-9 toggles · c: for Claude{hasWaiting ? ' · w:Name waits on someone' : ''}
          {hasDecisions ? ' · d: decision' : ''}
        </Text>
        {group('For you', mine, 'warning')}
        {group('For Claude', claudes, 'claude')}
        {hasWaiting && waiting.length > 0 && group('Waiting on', waiting, 'suggestion')}
        {snoozed.length > 0 && (
          <Text key="snoozed" dimColor>
            Snoozed {snoozed.length}: {snoozed.map(item => `#${item.id} in ${shortWhen(now, item.snoozedUntil!)}`).join(', ')}
          </Text>
        )}
        {recent.length > 0 && (
          <Box key="recent" flexDirection="column" marginBottom={1}>
            <Text bold dimColor>Recently done</Text>
            {recent.map(row)}
          </Box>
        )}
        {e.surface !== 'mobile' && 'Input' in els && (
          <els.Input
            key="add"
            placeholder="Add a todo for you (c: Claude · w:Name waiting · d: decision)"
            submitLabel="add"
            onSubmit={text => {
              const waitingMatch = hasWaiting ? /^w:\s*([^\s:]+):?\s+(.*)$/i.exec(text) : null
              if (waitingMatch) {
                void addItem($, { text: waitingMatch[2]!, owner: 'waiting', waitingOn: waitingMatch[1] })
                return
              }
              const isClaudes = /^c:\s*/i.test(text)
              const isDecision = hasDecisions && /^d:\s*/i.test(text)
              void addItem($, {
                text: text.replace(/^[cd]:\s*/i, ''),
                owner: isClaudes ? 'claude' : 'me',
                kind: isDecision ? 'decision' : 'task',
              })
            }}
          />
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: NOTES_PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    const text = await read($, notes)

    if (e.surface === 'mobile' || !('Input' in els)) {
      return <Text>{text || 'The notepad is empty.'}</Text>
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {projectName(await read($, root))} · Enter saves · newline as in the prompt box
        </Text>
        <els.Input
          key="notes"
          rows={Math.max(3, e.props.scroll.bodyRows - 2)}
          value={notesDraft ?? text}
          placeholder="Notes for this project"
          submitLabel="save"
          onInput={value => {
            notesDraft = value
          }}
          onSubmit={value => {
            notesDraft = undefined
            void changeNotes($, () => value)
          }}
        />
      </Box>
    )
  })
}
