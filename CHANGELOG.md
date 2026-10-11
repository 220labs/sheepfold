# Changelog

## 0.5.5

- The list keeps refreshing while the view is hidden, at most once a minute, so the badge and
  the nudges work when you are not looking at the sidebar.
- A loop in parent links, or a chain deeper than 32, no longer hides sessions.
- A session first seen already needing you nudges too.
- A row's tooltip says what a click does with `sheepfold.resume` off.
- A row that started an active session opens again when it turns active.
- `sheepfold.cli`, `claudeConfigDir` and `remotes` are machine settings, and Sheepfold does not
  run in an untrusted workspace: a folder's settings cannot choose the program it runs.
- "Show all" and "Cap" set the state rather than flip it.

## 0.5.4

- A 128 px PNG icon for the Marketplace and Open VSX, rendered from `media/icon.svg` into the
  ignored `build/` by `scripts/render_icon.js` (headless Chrome) at every check; a coral gallery
  banner.

## 0.5.3

- The name is lowercase, `sheepfold`, as the lab writes its tools; the listing's description and
  keywords are set. "Baa" lost its exclamation mark.
- `scripts/build_icons.py` writes every icon SVG (`npm run icons`); `scripts/demo-cli.js` prints
  synthetic sessions for screenshots (README, "Screenshots").

## 0.5.2

- A session nests under its parent when the CLI reports `parent_id` (sessionpipe's session
  field), which works across machines; the local link file is the fallback.

## 0.5.1

- The icon is spark wool: a woolly sheep whose fleece breaks into spark rays, picked from four
  candidates (`scripts/build_icons.py` draws all four).

## 0.5.0

- An icon: a woolly sheep under a spark-shaped star, in the activity bar (`media/sheepfold.svg`);
  the colour tile is `media/icon.svg`.
- A session started by another nests under it, read from `~/.sheepfold/children/<id>.json`
  (README, "Child links"). A row whose child is active stays in view.
- The activity-bar icon shows how many sessions need you; with none, a line over the list says
  what is working or that all is quiet.
- Status-bar nudge for 15 seconds when a session starts needing you or finishes; a click goes
  there (`sheepfold.nudges`).
- Wool in the copy where no state word lives: "N more in the fold…", the empty and error
  messages. State names are unchanged.

## 0.4.0

- Navigation only by default: a session in this workspace opens in Claude Code; every other
  session opens its spacesheep page. Resuming in a new window or over SSH, and the
  "Open in new window" menu entry, need `sheepfold.resume` (default off).

## 0.3.1

- "Show on spacesheep" opens the session's own page, `/sessions/{source}/{id}`, instead of
  the sessions list (`sheepfold.remoteSessionPath`).

## 0.3.0

- Working and needs-you sessions always show, and projects that have them come first. Idle and
  finished sessions are capped per project (`sheepfold.inactivePerGroup`, default 3) behind a
  "N more…" row; an eye button in the view title shows them all. Projects with nothing active
  start collapsed.
- Non-interactive (dispatched) sessions nest under one "dispatched (n)" node in their project,
  detected from the transcript's entrypoint or a title pattern
  (`sheepfold.dispatchedTitlePattern`).
- The view shows this machine's name; a server button adds `@<machine>` to every row.

## 0.2.1

- The hand-over to a freshly opened window is a file, `~/.sheepfold/pending.json`, on the host
  where the window runs (VS Code storage is per profile and silently missed). Over SSH it is
  written with `ssh -o BatchMode=yes`; on failure Sheepfold shows the error and offers spacesheep.
- A session whose folder was removed is no longer `here`: Claude Code opens a removed worktree
  blank. It shows `worktree removed` and opens on spacesheep.

## 0.2.0

- Every row is classified by whether a click can open it, and shows it: `↗ <repo>` for a folder
  that is not open, `⇄ <machine>` for another machine, `no transcript`. The tooltip says what a
  click does.
- Clicks never open a blank Claude Code: a session from another folder opens that folder in a
  new window and resumes there; a session on another machine can open over Remote-SSH
  (`sheepfold.remotes`); the rest open on spacesheep.
- Sessions that never got a prompt are hidden (`sheepfold.showEmpty`); nameless ones are labelled
  with their first prompt, read from the local transcript.
- Context menu: Open in New Window, Show on spacesheep.
- Settings: `sheepfold.showEmpty`, `sheepfold.claudeConfigDir`, `sheepfold.remotes`.
- Declared a workspace extension, so it runs on a Remote-SSH host.

## 0.1.0

- Sidebar of recent coding-agent sessions from `spacesheep sessions list`, grouped by project,
  needs-attention first, refreshed while visible.
- A session on this machine opens in the Claude Code extension; one on another machine opens
  through the local `spacesheep mirror` in VS Code's Simple Browser.
- Context menu: copy session ID, open on claude.ai, reveal folder.
