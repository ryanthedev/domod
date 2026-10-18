import { expect, mock, test } from 'claude-code/testing'

const COMPOSE = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: [],
  outputStyle: null,
  traits: [],
} as const

const stored = (fields: Record<string, unknown>) => ({
  id: 1,
  text: 'An item',
  owner: 'me',
  isDone: false,
  root: '',
  createdAt: 0,
  doneAt: null,
  ...fields,
})

test('todo_add records an item for the person and todo_done closes it', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 1000 })
  mock.env(on, {})

  const added = await $.tool.call({ tool: 'mcp__domod__todo_add', text: 'Review PR 4242', owner: 'me' })
  expect(added.result).toBe('Added #1 [me] Review PR 4242')

  const listed = await $.tool.call({ tool: 'mcp__domod__todo_list' })
  expect(listed.result).toBe('#1 [me] Review PR 4242')

  const done = await $.tool.call({ tool: 'mcp__domod__todo_done', id: 1 })
  expect(done.result).toBe('Done: #1 [me] (done) Review PR 4242')

  const after = await $.tool.call({ tool: 'mcp__domod__todo_list' })
  expect(after.result).toBe('The domod is empty.')
})

test('items another session stored are kept, and new ids follow the highest', async ($, on) => {
  mock.store(on, { items: [stored({ id: 7, text: 'From another session', owner: 'claude' })] })
  mock.clock(on)
  mock.env(on, {})

  const added = await $.tool.call({ tool: 'mcp__domod__todo_add', text: 'Mine', owner: 'me' })
  expect(added.result).toBe('Added #8 [me] Mine')

  const listed = await $.tool.call({ tool: 'mcp__domod__todo_list' })
  expect(listed.result).toBe('#7 [claude] From another session\n#8 [me] Mine')
})

test('waiting and decision items carry who and what kind', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  mock.env(on, {})

  const waiting = await $.tool.call({
    tool: 'mcp__domod__todo_add',
    text: 'Grant API access',
    owner: 'waiting',
    waitingOn: 'Sam',
  })
  expect(waiting.result).toBe('Added #1 [waiting on Sam] Grant API access')

  const decision = await $.tool.call({
    tool: 'mcp__domod__todo_add',
    text: 'Go/no-go on the staging deploy',
    owner: 'me',
    kind: 'decision',
  })
  expect(decision.result).toBe('Added #2 [me, decision] Go/no-go on the staging deploy')
})

test('with waiting and decisions switched off, those fall back to plain items', { options: { waitingOn: false, decisions: false } }, async ($, on) => {
  mock.store(on)
  mock.clock(on)
  mock.env(on, {})

  const added = await $.tool.call({
    tool: 'mcp__domod__todo_add',
    text: 'Grant API access',
    owner: 'waiting',
    kind: 'decision',
    waitingOn: 'Sam',
  })
  expect(added.result).toBe('Added #1 [me] Grant API access')
})

test('/todo snooze hides an item until it wakes', async ($, on) => {
  mock.store(on, { items: [stored({ text: 'Check the staging deploy' })] })
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, {})

  const ran = await $.command.run({ command: 'todo', args: 'snooze 1 2h' })
  expect(ran.text).toBe('Snoozed #1 for 2h: Check the staging deploy')

  const all = await $.command.run({ command: 'todo', args: 'all' })
  expect(all.text).toBe('Nothing open anywhere.')

  await clock.advance(3 * 60 * 60 * 1000)
  const later = await $.command.run({ command: 'todo', args: 'all' })
  expect(later.text).toBe('#1 [me] Check the staging deploy')
})

test('a gh pr merge Claude runs closes the item naming that PR, and /todo undo reopens it', async ($, on) => {
  mock.store(on, {
    items: [stored({ text: 'Review and merge PRs 4242, 4243' }), stored({ id: 2, text: 'Unrelated' })],
  })
  mock.clock(on)
  mock.env(on, {})
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'merged', stderr: '', interrupted: false } as never }))

  await $.tool.call({ tool: 'Bash', command: 'gh pr merge 4243 --squash' })
  const listed = await $.tool.call({ tool: 'mcp__domod__todo_list' })
  expect(listed.result).toBe('#2 [me] Unrelated')

  const undone = await $.command.run({ command: 'todo', args: 'undo' })
  expect(undone.text).toBe('Reopened #1.')
})

test('an echo of gh pr merge closes nothing', async ($, on) => {
  mock.store(on, { items: [stored({ text: 'Merge PR 4243' })] })
  mock.clock(on)
  mock.env(on, {})
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } as never }))

  await $.tool.call({ tool: 'Bash', command: 'echo "gh pr merge 4243"' })
  const listed = await $.tool.call({ tool: 'mcp__domod__todo_list' })
  expect(listed.result).toBe('#1 [me] Merge PR 4243')
})

test('with auto-close off, a merge closes nothing', { options: { autoClose: false } }, async ($, on) => {
  mock.store(on, { items: [stored({ text: 'Merge PR 4243' })] })
  mock.clock(on)
  mock.env(on, {})
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } as never }))

  await $.tool.call({ tool: 'Bash', command: 'gh pr merge 4243' })
  const listed = await $.tool.call({ tool: 'mcp__domod__todo_list' })
  expect(listed.result).toBe('#1 [me] Merge PR 4243')
})

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

test('a reply that asks something of the person is harvested into the triage card', async ($, on) => {
  mock.store(on, { items: [stored({ text: 'Approve PR 4242' })] })
  mock.clock(on)
  mock.env(on, {})
  const asked: string[] = []
  on('model.complete', ($, e) => {
    asked.push(e.prompt)
    return { value: {
      isAnswered: true,
      text: '[{"text":"Approve PR 4242","owner":"me","kind":"task"},{"text":"Go/no-go on the staging deploy","owner":"me","kind":"decision"},{"text":"Grant API access","owner":"waiting","kind":"task","waitingOn":"Sam"}]',
      usage: USAGE,
    } }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await $.turn.complete({
    answer: 'What you need to do: approve PR 4242 and decide go/no-go on the staging deploy.',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  for (let tries = 0; tries < 20 && toasts.length === 0; tries++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }

  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('#1 [me] Approve PR 4242')
  // The already-open PR item is left out: two new ones reach the card.
  expect(toasts).toEqual(['domod found 2 action items: sort them above the prompt'])
})

test('a reply that asks nothing makes no model call', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  mock.env(on, {})
  let calls = 0
  on('model.complete', () => {
    calls += 1
    return { value: { isAnswered: true, text: '[]', usage: USAGE } } as const
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))

  await $.turn.complete({ answer: 'Done. The tests pass.', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(calls).toBe(0)
})

test('/todo done without an id shows usage instead of adding an item', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  mock.env(on, {})

  const ran = await $.command.run({ command: 'todo', args: 'done' })
  expect(ran.text).toContain('Usage: /todo done <id>')

  const listed = await $.tool.call({ tool: 'mcp__domod__todo_list' })
  expect(listed.result).toBe('The domod is empty.')
})

test('the instructions section is added only where the tools are offered', async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))

  const withTools = await $.prompt.compose({ ...COMPOSE, tools: ['mcp__domod__todo_add'] })
  expect(withTools.sections.map(one => one.id)).toEqual(['domod:instructions'])

  const without = await $.prompt.compose({ ...COMPOSE, tools: [] })
  expect(without.sections).toEqual([])
})
