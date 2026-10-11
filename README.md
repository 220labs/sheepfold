# Sheepfold

A VS Code sidebar that lists your recent coding-agent sessions as
[spacesheep](https://spacesheep.dev) tracks them, grouped by project, with the sessions that
need you first. Click one to go to it.

- A session whose folder is open opens in the Claude Code extension.
- Every other session opens its page on spacesheep.
- Sessions that never got a prompt are hidden: there is nothing to open.

That is all a click does by default: Sheepfold navigates and changes nothing. Resuming a
session from another folder (in a new window) or another machine (over Remote-SSH) is opt-in,
with `sheepfold.resume` (section "Resuming elsewhere").

## Requirements

- The `spacesheep` CLI (1.26 or later), signed in, with session reporting on. Sheepfold runs
  `spacesheep sessions list`; it holds no credentials of its own.
- The [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code)
  for opening sessions on this machine.
- `spacesheep mirror on` (CLI 1.27 or later) for opening sessions from other machines inside
  VS Code. Without it, Sheepfold opens spacesheep.dev in your browser instead.

VS Code started from the Dock may not see the `PATH` your shell has. If the sidebar says the
CLI was not found, set `sheepfold.cli` to its full path.

## Use

Open the Sheepfold icon in the activity bar. Sessions that need you or are working always show:
projects with any of them come first, then the rest by newest session. Inside a project the
active sessions lead; idle and finished ones follow, up to three, then a "N more…" row that
shows the rest (click it again for "show fewer"). The eye button in the view title shows every
idle and finished session at once, or caps them again. Projects with nothing active start
collapsed. Finished sessions older than a day are hidden.

The view's description is this machine's name. The server button in the view title adds
`@<machine>` to every row, to tell machines apart at a glance; the tooltip always names the
machine.

Non-interactive (dispatched) sessions, ones started by another tool rather than typed into, sit
together under a "dispatched (n)" node inside their project, one level deeper, with the same
active-first cap. A session counts as dispatched when its transcript says it ran through the
SDK CLI, or when its title matches `sheepfold.dispatchedTitlePattern` (default: a title ending
in ` · <word>`, like "repo: topic · host"). For sessions on other machines only the title can say. The list refreshes every 20 seconds while the view is
visible, at most once a minute while it is hidden (the badge and the nudges need it), and with
the refresh button.

A session started by another session nests under it, wherever its project: open while any of
them needs you or is working, folded otherwise. A row that started an active session stays in
view even when it is idle itself. A chain (a starts b, b starts c) nests flat under a. Sheepfold
learns who started whom from the CLI's `parent_id` (sessionpipe's session field, which works
across machines) or, failing that, a link file the launcher writes on the parent's machine (see
"Child links"); a session whose parent is not in the list stays where it would be without one.

The Sheepfold icon carries a badge with the number of sessions that need you. With nothing
needing you, a line over the list says what is still working, or that all is quiet. When a
session starts needing you or finishes, the status bar says so for 15 seconds ("Baa, app: login
needs you", "Back in the fold: app: login"); click it to go there. `sheepfold.nudges` turns that
off.

Each row says what a click does. After the time, the description carries a hint: `↗ app` (a
folder that is not open here), `⇄ server` (another machine), `no transcript` (the transcript is
not on this machine). The tooltip spells it out.

- Folder open here: the session opens in Claude Code.
- `↗ app` and `⇄ server`: the session opens on spacesheep. Claude Code resumes a session only
  when its transcript belongs to the folder (or a worktree of the folder) that is open, so it
  could not open here; with `sheepfold.resume` on, a click offers to open the folder in a new
  window (or over SSH) and resume there.
- `no transcript`: the transcript is not on this machine; the row opens on spacesheep.
- `worktree removed` (or `folder removed`): the session's folder is gone, and Claude Code cannot
  resume a session from a removed worktree; the row opens on spacesheep.
- A nameless session shows the first words of its first prompt, read from the local transcript.
- Sessions with no prompt at all are hidden; `sheepfold.showEmpty` shows them.

"Show on spacesheep" opens the session's own page (`/sessions/<source>/<id>`). Through
the local mirror when it runs, else spacesheep.dev in your browser.

Right-click a session to show it on spacesheep, copy its ID, open it on claude.ai (when it has
a URL) or reveal its folder (local sessions); with `sheepfold.resume` on, also to open it in a
new window.

### Resuming elsewhere (opt-in)

Set `sheepfold.resume` to `true`. A session from another folder then offers "Open app in a new
window and resume there"; a session on another machine offers "Open on server over SSH and
resume there" once the machine is in `sheepfold.remotes`. For other machines, add the machine to `sheepfold.remotes`, keyed by the name the list shows:

```json
"sheepfold.remotes": {
  "server": { "sshHost": "server", "home": "/home/me" }
}
```

`sshHost` is the host as Remote-SSH names it; `home` is that machine's home directory, which a
leading `~` in the session's folder expands to. Sheepfold declares itself a workspace
extension, so in a Remote-SSH window it runs on the remote host and sees that machine's
sessions as local. Install it there once (Extensions, "Install in SSH: server"). On the
remote, the spacesheep CLI must be signed in only to see the list in that window; resuming a
session after the window opens needs no CLI.

Known limit: the hand-over to the new window is a small file, `~/.sheepfold/pending.json`, written
on the host where the new window's extension runs (it is not VS Code storage, which is per
profile). For a Remote-SSH click Sheepfold writes it with `ssh -o BatchMode=yes <sshHost>`, so
the machine needs ssh key access without a password prompt. If that fails, Sheepfold shows
ssh's error and offers "Show on spacesheep" instead of opening a window that cannot resume.
The window resumes the session within two minutes of the click; the file is deleted once it
fires or goes stale.

### Child links

Any tool that starts a session on behalf of another writes one file per child, on the machine
where the parent runs:

```
~/.sheepfold/children/<child session id>.json    {"parent": "<parent session id>"}
```

Sheepfold only reads these (each file once, until it changes); the tool that writes them owns
pruning. A link from another machine is not visible here, so a parent on this machine and a
child on another nest only when the link is written on this machine.

## Screenshots

Never from real sessions. Point `sheepfold.cli` at `scripts/demo-cli.js` (full path) and set
`sheepfold.refreshSeconds` to 5: it prints twelve synthetic sessions in three projects, and runs a
60-second loop in which one session starts needing you and another finishes, so both nudges show.
Local rows say `no transcript`, since no transcript exists for them.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `sheepfold.cli` | `spacesheep` | The CLI to run. A bare name is looked up on `PATH`. |
| `sheepfold.refreshSeconds` | `20` | Refresh interval while the view is visible; hidden, at least 60 s. |
| `sheepfold.hideDoneAfterHours` | `24` | Hide finished sessions older than this. `0` shows all. |
| `sheepfold.localMachines` | `[]` | Machine names to treat as this machine, besides the host name. |
| `sheepfold.mirrorUrl` | `http://localhost:4280` | Base URL of the local spacesheep mirror. |
| `sheepfold.remoteSessionPath` | `/sessions/{source}/{id}` | Path for "Show on spacesheep". Placeholders `{source}`, `{id}`, `{machine}`. |
| `sheepfold.remoteOpenIn` | `simpleBrowser` | `simpleBrowser` or `external`. |
| `sheepfold.inactivePerGroup` | `3` | Idle and finished sessions shown per project (and per dispatched node). Active ones always show. `0` shows none until expanded. |
| `sheepfold.dispatchedTitlePattern` | `\s·\s\S+$` | Regex for titles of dispatched sessions. Empty turns the title test off. |
| `sheepfold.showEmpty` | `false` | Show sessions that never got a prompt. |
| `sheepfold.claudeConfigDir` | empty | Claude Code's config directory (where transcripts live). Empty: the `CLAUDE_CONFIG_DIR` entry of the Claude Code setting `claudeCode.environmentVariables`, else the environment variable, else `~/.claude`. |
| `sheepfold.resume` | `false` | Offer to resume sessions from other folders (new window) or machines (Remote-SSH). Off: clicks only navigate. |
| `sheepfold.nudges` | `true` | Status-bar nudge for 15 seconds when a session starts needing you or finishes. |
| `sheepfold.remotes` | `{}` | Machines reachable over SSH: `{ "<machine>": { "sshHost": "...", "home": "..." } }`. |

## Install

Build the package and install it from the `.vsix`:

```bash
npm ci && npm run check
code --install-extension sheepfold-*.vsix
```

## Not in this version

Paging past the newest 100 sessions, filtering by source or machine.

## License

MIT
