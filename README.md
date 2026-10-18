# domod

A todo list and notepad for Claude Code that you and Claude share, and that lasts across sessions.

At the end of a session Claude often hands you a list: review this PR, decide go or no-go on that deploy, wait for someone to grant access. domod keeps that list. Claude files the items it leaves you, takes the ones you hand back, and closes them when the work is done. You see what's open in a pane, in a line above the prompt, and in your status line.

## Install

```bash
/plugin marketplace add ryanthedev/rtd-claude-inn
/plugin install domod@rtd
```

Or straight from this repository:

```bash
/plugin install domod --marketplace ryanthedev/domod
```

From a shell, use `claude plugin install domod@rtd`. The PR features need the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`).

## Use it

| Command | What it does |
|---|---|
| `/todo` | Opens the list |
| `/todo <text>` | Adds an item for you |
| `/todo done <id>` | Closes an item |
| `/todo snooze <id> 2h` | Hides an item until later (`45m`, `3d`, `tomorrow`, `mon`) |
| `/todo undo` | Reopens what an auto-close closed |
| `/todo all` | Lists open items in every project |
| `/note` | Opens this project's notepad |
| `/note <text>` | Adds a line to the notepad |

Items belong to the project you add them in. Each one has an owner: **you**, **Claude**, or **waiting on** a named person. A **decision** item is a go/no-go or a choice only you can make.

**In the pane**, `1`-`9` check off the first nine open items. Each row has buttons to hand it over (`→Claude`, `→me`), snooze it (`zz`), run it (`▶ run`, on Claude's items) or decide it (`go`, `no-go`). In the add box, start with `c:` for Claude, `d:` for a decision, or `w:Name` for an item waiting on someone.

**Above the prompt**, domod shows your oldest open item. When a reply asks something of you, it shows the items it found instead, to sort with `y` (you), `c` (Claude), `r` (run now), `w` (waiting), `x` (drop) or `a` (accept all). Focus that line with `ctrl+x tab` to use those keys.

**Claude** gets five tools (`todo_add`, `todo_done`, `todo_update`, `todo_list`, `note_append`) and a short instruction to use them. The open list rides along with your prompt only when it changed, so it costs little.

## What it does on its own

Each of these is a setting you can turn off in `/config`.

| Setting | Default | What it does |
|---|---|---|
| Harvest action items | on | When a reply contains a request ("What you need to do", "Your turn"), a small model lists the action items for you to sort. One call per such reply. |
| Harvest teammate messages | on | Also reads messages other sessions and teammates send into this one. |
| Harvest model | haiku | `haiku` or `sonnet`. |
| Run now buttons | on | Claude's items get a button that sends the item to Claude as a prompt. |
| Decision buttons | on | Decision items get go and no-go buttons; Claude hears your answer with your next prompt. |
| Auto-close from commands | on | When Claude runs `gh pr merge` or `gh pr close` on a PR an item names, or the PR shows merged, the item closes. `/todo undo` reopens it. |
| PR status badges | on | Shows merged, approved, changes requested or failing checks beside items that name a PR. |
| PR check interval | 10 min | How often PR status is checked. |
| Waiting-on items | on | Items can wait on a named person. |
| Snooze | on | Items can be hidden until later. |
| Desktop notifications | on | Notifies you when a snoozed item comes back or a PR an item names is merged. |

An item names a PR with a GitHub URL, `owner/repo#123`, or `PR 123` (the project's own repository). `repo #123` without the owner is not recognized.

## Status line

domod writes the open counts for each project to `~/.claude/domod/counts.json`:

```json
{ "/path/to/project": { "me": 3, "claude": 1, "waiting": 0 } }
```

A status line script can read the current project's counts with `jq`:

```bash
project=$(jq -r '.workspace.project_dir // .cwd' <<<"$input")
jq -r --arg p "$project" '"\(.[$p].me // 0) you, \(.[$p].claude // 0) Claude"' ~/.claude/domod/counts.json
```

## Keys

These bindings for `~/.claude/keybindings.json` jump to the list and move through it:

```json
{
  "bindings": [
    { "context": "Chat", "bindings": { "ctrl+w l": "abovePrompt:focus", "ctrl+w t": "command:todo", "ctrl+w n": "command:note" } },
    { "context": "Pane", "bindings": { "j": "abovePrompt:next", "k": "abovePrompt:previous", "]": "pane:next", "[": "pane:previous" } }
  ]
}
```

## Notes

- Several sessions can run at once: each change re-reads the saved list first, and every session picks up the others' changes within five seconds.
- Done items are removed after 30 days.
- Where an organization manages Claude Code, it may skip the instruction domod gives Claude. The tools, panes and harvester still work.
