# Sheepfold

A VS Code sidebar that lists your recent coding-agent sessions as
[spacesheep](https://spacesheep.dev) tracks them, grouped by project, with the sessions that
need you first. Click one to go to it.

- A session whose folder is open opens in the Claude Code extension.
- A session run through an Agent SDK opens its spacesheep page: Claude Code cannot open those.
- Every other session opens its page on spacesheep, in a VS Code tab (or your browser, with
  `sheepfold.openIn`).
- Sessions that never got a prompt are hidden: there is nothing to open.

That is all a click does by default: Sheepfold navigates and changes nothing. Resuming a
session from another folder (in a new window) or another machine (over Remote-SSH) is opt-in,
with `sheepfold.resume` (section "Resuming elsewhere").

## Requirements

- The `spacesheep` CLI (1.26 or later), signed in, with session reporting on. Sheepfold runs
  `spacesheep sessions list`; it holds no credentials of its own.
- The [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code)
  for opening sessions on this machine.
- `spacesheep mirror on` (CLI 1.27 or later) for spacesheep pages in a VS Code tab (section
  "spacesheep pages in VS Code"); without it they open in your browser.

VS Code started from the Dock may not see the `PATH` your shell has. If the sidebar says the
CLI was not found, set `sheepfold.cli` to its full path.

## Use

Open the Sheepfold icon in the activity bar. Sessions that need you or are working always show:
projects with any of them come first, then the rest by newest session. Inside a project the
active sessions lead; idle and finished ones follow, up to three, then a "N more…" row that
shows the rest (click it again for "show fewer"). The eye button in the view title shows every
idle and finished session at once, or caps them again. Projects with nothing active start
collapsed. Finished sessions older than a day are hidden.

The view's description is this machine's name as the spacesheep CLI reports it (the name given
to `spacesheep connect` or `--machine`, else the host name without `.local`, `.lan` or `.home`);
sessions under that name are this machine's. The server button in the view title adds
`@<machine>` to every row, to tell machines apart at a glance; the tooltip always names the
machine.

Non-interactive (dispatched) sessions, ones started by another tool rather than typed into, sit
together under a "dispatched (n)" node inside their project, one level deeper, with the same
active-first cap. A session counts as dispatched when its transcript says it ran through the
SDK CLI, or when its title matches `sheepfold.dispatchedTitlePattern` (empty by default; if your
launcher names its runs like "repo: topic · host", `\s·\s\S+$`). For sessions on other machines
only the title can say. The list refreshes every 20 seconds while the view is
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
not on this machine), `SDK` (run through an Agent SDK or `claude -p`). The tooltip spells it out.

- Folder open here: the session opens in Claude Code.
- `↗ app` and `⇄ server`: the session opens on spacesheep. Claude Code resumes a session only
  when its transcript belongs to the folder (or a worktree of the folder) that is open, so it
  could not open here; with `sheepfold.resume` on, a click offers to open the folder in a new
  window (or over SSH) and resume there.
- `no transcript`: the transcript is not on this machine; the row opens on spacesheep.
- `SDK`: the session ran through an Agent SDK or `claude -p`. Claude Code leaves these out of its
  list and would open a blank session, so the row opens on spacesheep. A dispatched session on
  another machine is not offered the SSH resume either, for the same reason.
- `worktree removed` (or `folder removed`): the session's folder is gone, and Claude Code cannot
  resume a session from a removed worktree; the row opens on spacesheep.
- A nameless session shows the first words of its first prompt, read from the local transcript.
- Sessions with no prompt at all are hidden; `sheepfold.showEmpty` shows them.

"Show on spacesheep" opens the session's own page (`/sessions/<source>/<id>`).

Right-click a session to show it on spacesheep, open it in your browser (to send it messages,
below), copy its ID, open it on claude.ai (when it has a URL) or reveal its folder (local
sessions); with `sheepfold.resume` on, also to open it in a new window.

### spacesheep pages in VS Code

spacesheep.dev does not allow itself inside another page, and a VS Code tab is one. The
spacesheep CLI's mirror serves the same site from this machine, framable and signed in with the
CLI's own key (Google accounts included): `spacesheep mirror on`, CLI 1.27 or later. While it
runs, a spacesheep page (a session's page, and every page you click through to from it) opens in
a VS Code tab; otherwise in your browser, with a one-time note saying so.

- Sheepfold asks the CLI where the mirror runs (`spacesheep mirror status`) and uses it only when
  it mirrors the site the CLI points at; `sheepfold.mirrorUrl` overrides that.
- In a Remote-SSH window the mirror runs on the remote host and VS Code forwards its port. The
  mirror only works on its own port number, so if that port is taken on your machine (say, by
  a mirror of your own), pages open in the browser; `spacesheep mirror on --port <n>` on the
  remote picks another.
- `sheepfold.openIn` set to `browser` opens every page in your browser.
- "Open on claude.ai" always opens your browser.
- **Messages to a session are sent from the browser.** A session page's Session tab signs each
  message with a passkey made for the spacesheep site, and a page served from the mirror
  (`localhost`) cannot use it, so in a VS Code tab the page reads but cannot send. The speech
  bubble in the tab's title bar (and "Open in Browser" on a row's menu) opens the same session
  on the spacesheep site in your browser, where sending works. The tab's own "open in browser"
  button opens the mirror's address, where sending fails too. The fix that makes the tab itself
  send is proposed to spacesheep in `docs/talk-from-tab-2026-10-16.md`.

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
The window resumes the session within two minutes of the click; the file is deleted once Claude
Code has taken the open command there, or once it goes stale. A folder already open in another
window is not opened twice: VS Code brings that window forward, and the session resumes there.
A window that cannot resume (Claude Code missing, or not starting) says so and offers to try
again. A local hand-over that no window took is removed after two minutes, and the window you
clicked in says so.

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

Never from real sessions. In a checkout of the repository (the script is not in the installed
extension; macOS or Linux), point `sheepfold.cli` at `scripts/demo-cli.js` (full path) and set
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
| `sheepfold.openIn` | `editor` | Where spacesheep pages open: `editor` (a VS Code tab, through the mirror while it runs) or `browser`. |
| `sheepfold.mirrorUrl` | empty | The mirror's base URL. Empty: ask the CLI (`spacesheep mirror status`). |
| `sheepfold.remoteSessionPath` | `/sessions/{source}/{id}` | Path for "Show on spacesheep". Placeholders `{source}`, `{id}`, `{machine}`. |
| `sheepfold.remoteOpenIn` | `simpleBrowser` | Deprecated: use `sheepfold.openIn`. `external` still means the browser while `openIn` is unset. |
| `sheepfold.inactivePerGroup` | `3` | Idle and finished sessions shown per project (and per dispatched node). Active ones always show. `0` shows none until expanded. |
| `sheepfold.dispatchedTitlePattern` | empty | Regex for titles of dispatched sessions. Empty: the title is not tested. |
| `sheepfold.showEmpty` | `false` | Show sessions that never got a prompt. |
| `sheepfold.claudeConfigDir` | empty | Claude Code's config directory (where transcripts live). Empty: the `CLAUDE_CONFIG_DIR` entry of the Claude Code setting `claudeCode.environmentVariables`, else the environment variable, else `~/.claude`. |
| `sheepfold.resume` | `false` | Offer to resume sessions from other folders (new window) or machines (Remote-SSH). Off: clicks only navigate. |
| `sheepfold.nudges` | `true` | Status-bar nudge for 15 seconds when a session starts needing you or finishes. |
| `sheepfold.remotes` | `{}` | Machines reachable over SSH: `{ "<machine>": { "sshHost": "...", "home": "..." } }`. |

## Install

From the VS Code Marketplace: search for "sheepfold" in the Extensions view. Or build the
package from a checkout (the check renders the icon with Chrome) and install the `.vsix`:

```bash
npm ci && npm run check
code --install-extension sheepfold-*.vsix
```

## Not in this version

Paging past the newest 100 sessions, filtering by source or machine.

## License

MIT
