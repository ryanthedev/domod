export type PunchOwner = 'me' | 'claude' | 'waiting'

export type PunchKind = 'task' | 'decision'

export type PunchItem = {
  id: number
  text: string
  owner: PunchOwner
  isDone: boolean
  root: string
  createdAt: number
  doneAt: number | null
  // Fields below arrived after 0.1.0; stored items may lack them.
  kind?: PunchKind
  waitingOn?: string
  snoozedUntil?: number | null
  doneBy?: string
  // Set when the text came from someone other than the person or Claude.
  from?: string
  decision?: { answer: 'go' | 'no-go'; at: number; isSent: boolean }
}

// An action item the harvester found, waiting for the person to sort it.
export type PunchFound = {
  key: string
  text: string
  owner: PunchOwner
  kind: PunchKind
  waitingOn?: string
  source: string
}

// What `gh pr view` last said about one PR an item names.
export type PunchPr = {
  state: 'open' | 'merged' | 'closed'
  review: string
  checks: 'passing' | 'failing' | 'pending' | 'none'
  url: string
}

declare module 'claude-code' {
  interface PluginState {
    domod: {
      items: PunchItem[]
      notes: string
      root: string
      found: PunchFound[]
      prs: Record<string, PunchPr>
    }
  }
}
