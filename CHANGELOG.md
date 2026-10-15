# Changelog

## 0.6.0

- spacesheep pages open in a VS Code tab through the CLI's mirror (`spacesheep mirror on`, CLI
  1.27+), found by asking the CLI (`spacesheep mirror status`) instead of probing port 4280,
  where anything that answered was taken for it. Without a mirror they open in the browser.
  New setting `sheepfold.openIn`: `editor` (default) or `browser`; `sheepfold.remoteOpenIn` is
  deprecated, and its `external` is still honoured. `sheepfold.mirrorUrl` is now an override,
  empty by default.
- Works beyond the author's setup:
  - Windows: an npm-installed CLI (a `.cmd` shim) runs; paths with `\` and either drive-letter
    case match the open folders, so worktree sessions open in Claude Code.
  - This machine is the name the CLI reports it under (`connect`/`--machine`), and a host name
    loses `.lan` and `.home` as well as `.local`, as the CLI does.
  - A CLI pointed at another site (`SPACESHEEP_APP_ORIGIN`, `appOrigin`) points the pages there.
  - `sheepfold.dispatchedTitlePattern` is empty by default; the README gives the old value as an
    example.
  - No Simple Browser (some VS Code builds): pages open in the browser instead of an error.
- Resuming elsewhere (`sheepfold.resume`), from the review of 2026-10-10:
  - A folder already open in another window resumes there: VS Code brings that window forward
    and it takes the hand-over on focus. A folder open in this window resumes here.
  - The new window starts Claude Code itself rather than waiting for it, keeps the hand-over
    until the session has opened, and says so with "Try again" when it cannot.
  - A local hand-over no window took is removed after two minutes, and the window you clicked
    in says so.
  - A remote folder with `#`, `?` or `%` in its path opens that folder.
- Faster with many sessions: a transcript is looked for in its own project folder before every
  folder is listed, a scan that found the first prompt is not redone as the session grows, and
  only the first 200 characters of that prompt are kept.
- A child link caught half-written by its launcher shows once complete, and a rewrite within the
  same second is read again.
- `npm run icon` shows Chrome's own error when no PNG comes back.

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
