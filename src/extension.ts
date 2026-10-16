import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  offersSshResume,
  Classification,
  Group,
  MoreRow,
  PendingOpen,
  PENDING_MAX_AGE_MS,
  PENDING_TAKEN_HOLD_MS,
  parsePending,
  sameFolder,
  Nudge,
  Session,
  State,
  badgeTooltip,
  childLayout,
  classify,
  claudeCodeUri,
  compileDispatchedPattern,
  dispatchedLayout,
  clickHint,
  decidePending,
  escapeMarkdown,
  excludeEmpty,
  expandHome,
  FALLBACK_BASE,
  fallbackSessionUrl,
  mirrorFromStatus,
  resolveOpenIn,
  findRemote,
  firstLine,
  groupLayout,
  groupSessions,
  iconState,
  isActive,
  isLocal,
  refreshDelaySeconds,
  machineName,
  mirrorSessionUrl,
  moreLabel,
  nudgeFor,
  nudgeText,
  parseSessions,
  quietLine,
  resumeWithRetry,
  samePending,
  stateMap,
  tally,
  projectKey,
  resolveConfigDir,
  sessionDescription,
  sessionLabel,
  sshFolderUri,
  tooltipFields,
} from './model';
import {
  ChildLinks,
  TranscriptIndex,
  childLinksDir,
  readCliSettings,
  deletePending,
  deletePendingIf,
  dirExists,
  readPending,
  writePending,
  writePendingOverSsh,
} from './local';

const CLAUDE_OPEN_COMMAND = 'claude-vscode.editor.open';
// Its id as `vscode.extensions.getExtension` takes it (the manifest says `Anthropic`; ids
// compare without case).
const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';

type Node =
  | { kind: 'group'; group: Group }
  | { kind: 'session'; session: Session; group: Group }
  | { kind: 'dispatched'; group: Group; count: number; expanded: boolean }
  | { kind: 'more'; more: MoreRow; scope: string };

const KEY_SHOW_HOSTS = 'sheepfold.showHosts';
const KEY_SHOW_ALL = 'sheepfold.showAllInactive';
const NUDGE_SECONDS = 15;

function settings() {
  return vscode.workspace.getConfiguration('sheepfold');
}

// What the CLI's own config says (its machine name, its site); re-read at every refresh.
let cliMachine: string | null = null;
let siteOrigin: string = FALLBACK_BASE;

function readCli(): void {
  const c = readCliSettings(process.env, os.homedir());
  cliMachine = c.machine;
  siteOrigin = c.appOrigin ?? FALLBACK_BASE;
}

function localOptions() {
  return { hostname: os.hostname(), localMachines: settings().get<string[]>('localMachines', []) };
}

/** This host as the session list names it. */
function thisMachine(): string {
  return machineName(os.hostname(), cliMachine);
}

function claudeConfigDir(): string {
  return resolveConfigDir({
    setting: settings().get<string>('claudeConfigDir', ''),
    claudeCodeEnv: vscode.workspace.getConfiguration('claudeCode').get('environmentVariables'),
    processEnv: process.env.CLAUDE_CONFIG_DIR,
    home: os.homedir(),
  });
}

function workspacePaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

function runCli(cli: string, args: readonly string[] = ['sessions', 'list', '--limit', '100'], timeout = 20_000): Promise<string> {
  const program = expandHome(cli, os.homedir());
  // On Windows an npm-installed CLI is a .cmd shim, which Node runs only through a shell: one
  // command line, the program quoted (an args array beside `shell` is deprecated, DEP0190). The
  // arguments are fixed words, so the shell sees nothing a user typed but the quoted path.
  const win = process.platform === 'win32';
  const command = win ? [`"${program.replace(/"/g, '')}"`, ...args].join(' ') : program;
  return new Promise((resolve, reject) => {
    execFile(
      command,
      win ? [] : [...args],
      { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true, shell: win },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          // Through cmd.exe a missing program is not ENOENT but its own message.
          if (code === 'ENOENT' || (win && /is not recognized as an internal or external command/i.test(String(stderr)))) {
            reject(new Error(`spacesheep CLI not found (${cli}). Set sheepfold.cli to its full path.`));
          } else {
            reject(new Error(firstLine(String(stderr)) || err.message));
          }
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

class SessionsProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private groups: Group[] = [];
  private sessions: Session[] = [];
  private classes = new Map<string, Classification>();
  private readonly index = new TranscriptIndex(claudeConfigDir());
  private readonly links = new ChildLinks(childLinksDir(os.homedir()));
  private parents = new Map<string, string>();
  // The state each row showed at the last good refresh; empty until the first, so the first
  // load nudges nothing.
  private previous = new Map<string, State>();
  /** What changed at the last refresh, for the status-bar nudge. */
  nudge: Nudge | null = null;
  // Scopes whose cap the user lifted; in memory only.
  private readonly expanded = new Set<string>();
  private now = Date.now();
  error: string | null = null;
  loaded = false;

  constructor(private readonly state: vscode.Memento) {}

  get showHosts(): boolean {
    return this.state.get<boolean>(KEY_SHOW_HOSTS, false);
  }

  get showAllInactive(): boolean {
    return this.state.get<boolean>(KEY_SHOW_ALL, false);
  }

  async toggleHosts(): Promise<void> {
    await this.state.update(KEY_SHOW_HOSTS, !this.showHosts);
    this.changed.fire(undefined);
  }

  async setShowAllInactive(on: boolean): Promise<void> {
    await this.state.update(KEY_SHOW_ALL, on);
    this.rebuild();
  }

  toggleMore(scope: string): void {
    if (!this.expanded.delete(scope)) this.expanded.add(scope);
    this.rebuild();
  }

  /** Regroup the rows already fetched (cap and toggle changes need no CLI run). */
  rebuild(): void {
    this.groups = groupSessions(this.sessions, {
      now: this.now,
      hideDoneAfterHours: settings().get<number>('hideDoneAfterHours', 24),
      exclude: excludeEmpty(this.classes, settings().get<boolean>('showEmpty', false)),
      inactivePerGroup: settings().get<number>('inactivePerGroup', 3),
      showAllInactive: this.showAllInactive,
      expanded: this.expanded,
      isDispatched: (s) => this.classes.get(s.sessionId)?.dispatched ?? false,
      // The CLI's parent_id works across machines; a local link file covers a CLI without it.
      parentOf: (s) => s.parentId ?? this.parents.get(s.sessionId) ?? null,
    });
    this.changed.fire(undefined);
  }

  async refresh(): Promise<void> {
    try {
      const parsed = parseSessions(await runCli(settings().get<string>('cli', 'spacesheep')));
      this.now = parsed.now ?? Date.now();
      this.index.setConfigDir(claudeConfigDir());
      readCli();
      const { hostname, localMachines } = localOptions();
      const home = os.homedir();
      const folders = workspacePaths();
      const dispatchedPattern = compileDispatchedPattern(settings().get<string>('dispatchedTitlePattern', ''));
      this.sessions = parsed.sessions;
      this.parents = this.links.read();
      this.nudge = this.loaded && !this.error ? nudgeFor(this.previous, parsed.sessions) : null;
      this.previous = stateMap(parsed.sessions);
      this.classes = new Map();
      for (const s of parsed.sessions) {
        this.classes.set(
          s.sessionId,
          classify(s, {
            local: isLocal(s.machine, hostname, localMachines, cliMachine),
            folders,
            home,
            transcript: (id, cwd) => this.index.info(id, cwd),
            dirExists,
            dispatchedPattern,
          }),
        );
      }
      this.error = null;
    } catch (e) {
      this.sessions = [];
      this.classes = new Map();
      this.nudge = null;
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.loaded = true;
    this.rebuild();
  }

  sessionById(id: string): Session | undefined {
    return this.sessions.find((s) => s.sessionId === id);
  }

  classOf(s: Session): Classification | undefined {
    return this.classes.get(s.sessionId);
  }

  get groupList(): readonly Group[] {
    return this.groups;
  }

  label(s: Session): string {
    return sessionLabel(s, this.classes.get(s.sessionId)?.firstUser);
  }

  get status(): 'loading' | 'error' | 'empty' | 'ok' {
    if (!this.loaded) return 'loading';
    if (this.error) return 'error';
    return this.groups.length === 0 ? 'empty' : 'ok';
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.groups.map((group) => ({ kind: 'group', group }));
    const layout =
      node.kind === 'group'
        ? groupLayout(node.group)
        : node.kind === 'dispatched'
          ? dispatchedLayout(node.group)
          : node.kind === 'session'
            ? childLayout(node.group, node.session.sessionId)
            : [];
    return layout.map((item): Node => {
      if (item.kind === 'session') return { kind: 'session', session: item.session, group: (node as { group: Group }).group };
      if (item.kind === 'dispatched') return { kind: 'dispatched', group: (node as { group: Group }).group, count: item.count, expanded: item.expanded };
      return { kind: 'more', more: item.more, scope: item.scope };
    });
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const g = node.group;
      const item = new vscode.TreeItem(
        g.key,
        g.collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.description = g.description;
      item.contextValue = 'group';
      // A stable id keeps the user's expand/collapse choice across refreshes.
      item.id = `group:${g.key}`;
      return item;
    }
    if (node.kind === 'dispatched') {
      const item = new vscode.TreeItem(
        `dispatched (${node.count})`,
        node.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
      );
      // VS Code keeps the expansion it remembers for a known id; the id carries the state we
      // want, so a node whose rows turn active opens again.
      item.id = `dispatched:${node.group.key}:${node.expanded ? 'open' : 'shut'}`;
      item.iconPath = new vscode.ThemeIcon('rocket');
      item.contextValue = 'dispatched';
      item.tooltip = 'Non-interactive sessions: started by another tool rather than typed into.';
      return item;
    }
    if (node.kind === 'more') {
      const item = new vscode.TreeItem(moreLabel(node.more), vscode.TreeItemCollapsibleState.None);
      item.id = `more:${node.scope}`;
      item.iconPath = new vscode.ThemeIcon('ellipsis');
      item.contextValue = 'more';
      item.command = { command: 'sheepfold.toggleMore', title: 'Toggle', arguments: [node] };
      return item;
    }
    const s = node.session;
    const c = this.classOf(s);
    const { hostname, localMachines } = localOptions();
    const local = isLocal(s.machine, hostname, localMachines, cliMachine);
    // A row that started other sessions holds them; open while any of them is active.
    const kids = node.group.children.get(s.sessionId) ?? [];
    const item = new vscode.TreeItem(
      sessionLabel(s, c?.firstUser),
      kids.length === 0
        ? vscode.TreeItemCollapsibleState.None
        : kids.some(isActive)
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
    );
    // A row with children carries its wanted expansion in its id, as the dispatched node does.
    item.id = kids.length === 0 ? `session:${s.sessionId}` : `session:${s.sessionId}:${kids.some(isActive) ? 'open' : 'shut'}`;
    item.description = sessionDescription(s, this.now, local, c, this.showHosts ? (s.machine ? machineName(s.machine) : thisMachine()) : null);
    item.iconPath = iconFor(s);
    item.tooltip = tooltipFor(s, c, thisMachine(), kids.length);
    item.contextValue = [
      'session',
      local ? 'local' : 'remote',
      s.url ? 'hasUrl' : '',
      c && c.kind !== 'empty' ? 'nonEmpty' : '',
    ]
      .filter(Boolean)
      .join(' ');
    item.command = { command: 'sheepfold.open', title: 'Open Session', arguments: [node] };
    return item;
  }
}

function iconFor(s: Session): vscode.ThemeIcon {
  switch (iconState(s)) {
    case 'needs_you':
      return new vscode.ThemeIcon('bell', new vscode.ThemeColor('list.warningForeground'));
    case 'working':
      return new vscode.ThemeIcon('sync~spin');
    case 'done':
      return new vscode.ThemeIcon('check', new vscode.ThemeColor('disabledForeground'));
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}

function remoteFor(s: Session) {
  return findRemote(settings().get<unknown>('remotes'), s.machine);
}

function tooltipFor(s: Session, c: Classification | undefined, here: string, started = 0): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, false);
  md.appendMarkdown(`**${escapeMarkdown(sessionLabel(s, c?.firstUser))}**\n\n`);
  for (const [label, value] of tooltipFields(s, here)) {
    md.appendMarkdown(`${label}: ${escapeMarkdown(value)}  \n`);
  }
  if (started > 0) md.appendMarkdown(`Started: ${started === 1 ? '1 session' : `${started} sessions`}, nested below  \n`);
  if (c) md.appendMarkdown(`\n${escapeMarkdown(clickHint(c, s, remoteFor(s) !== null, resumeEnabled()))}`);
  return md;
}

let noMirrorNoticeShown = false;
// What a click decided and why: the Output panel's "Sheepfold" channel, also a file in VS Code's
// logs, so a click that went to the browser can be explained without a debugger.
let log: vscode.LogOutputChannel | undefined;

/**
 * Where the spacesheep mirror runs: `sheepfold.mirrorUrl` when set, else what the CLI says
 * (`spacesheep mirror status --json`, CLI 1.27+). Null when none runs, or the CLI has no mirror
 * yet. Asking the CLI rather than probing a port: anything can answer on a port.
 */
// The last answer, kept two minutes: asking the CLI costs a process start (about 1.3 s seen from
// VS Code), and a click should not wait for it every time. Warmed at activation.
let mirrorCache: { base: string | null; at: number } | null = null;
const MIRROR_TTL_MS = 120_000;

async function mirrorBase(): Promise<string | null> {
  const set = settings().get<string>('mirrorUrl', '').trim();
  if (set) {
    log?.info(`mirror: sheepfold.mirrorUrl ${set}`);
    return set;
  }
  // "None" is kept only 15 s, so a mirror just turned on is seen at the next click or so.
  if (mirrorCache && Date.now() - mirrorCache.at < (mirrorCache.base ? MIRROR_TTL_MS : 15_000)) return mirrorCache.base;
  const base = await askMirror();
  mirrorCache = { base, at: Date.now() };
  return base;
}

async function askMirror(): Promise<string | null> {
  let out: string;
  try {
    out = await runCli(settings().get<string>('cli', 'spacesheep'), ['mirror', 'status', '--json'], 5_000);
  } catch (e) {
    log?.info(`mirror: none (\`spacesheep mirror status\` failed: ${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
  const base = mirrorFromStatus(out, siteOrigin);
  log?.info(base ? `mirror: ${base}` : `mirror: none for ${siteOrigin} (status said ${out.replace(/\s+/g, ' ').trim().slice(0, 200)})`);
  return base;
}

/** `sheepfold.openIn`; the old `remoteOpenIn: external` still means the browser if openIn is unset. */
function openIn(): 'editor' | 'browser' {
  const cfg = settings();
  const set = cfg.inspect<string>('openIn');
  return resolveOpenIn(
    { explicit: set?.workspaceFolderValue ?? set?.workspaceValue ?? set?.globalValue, effective: cfg.get<string>('openIn', 'editor') },
    cfg.get<string>('remoteOpenIn'),
  );
}

/**
 * A session's spacesheep page: in a VS Code tab through the mirror (spacesheep.dev refuses to
 * be framed; the mirror serves it framable, signed in with the CLI's key), else the browser.
 */
async function showOnSpacesheep(s: Session): Promise<void> {
  const opts = pageOptions();
  if (openIn() === 'editor') {
    const base = await mirrorBase();
    if (base) {
      try {
        // In a Remote-SSH window the mirror runs on the remote host: forward its port.
        // Forward only the base (Remote-SSH: the mirror runs on the remote host), then append the
        // path as built: a Uri round trip would decode its escapes (`%2F` → `/`).
        const forwarded = await vscode.env.asExternalUri(vscode.Uri.parse(base));
        const origin = new URL(forwarded.toString(true)).origin;
        // The mirror rewrites every link to its own port and refuses writes from another, so a
        // forward that lands on a different local port would half-work: the browser instead.
        if (new URL(origin).port !== new URL(base).port) {
          log?.warn(`mirror forwarded to ${origin}, not its own port ${new URL(base).port}: the browser instead`);
        } else {
          const url = mirrorSessionUrl(s, { ...opts, mirrorUrl: origin });
          log?.info(`open ${s.sessionId} in a tab: ${url}`);
          await vscode.commands.executeCommand('simpleBrowser.show', url);
          const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
          if (tab) tabSessions.set(tab, s);
          updateTabContext();
          return;
        }
      } catch (e) {
        // no Simple Browser (some VS Code builds): the browser below
        log?.warn(`tab failed, opening the browser: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (!noMirrorNoticeShown) {
      noMirrorNoticeShown = true;
      void vscode.window.showInformationMessage(
        'spacesheep pages open in a VS Code tab while `spacesheep mirror on` runs (spacesheep CLI 1.27 or later). Until then, in your browser.',
      );
    }
  }
  await openInBrowser(s, `openIn: ${openIn()}`);
}

function pageOptions() {
  return {
    mirrorUrl: '',
    remoteSessionPath: settings().get<string>('remoteSessionPath', '/sessions/{source}/{id}'),
    siteOrigin,
  };
}

/**
 * Which session Sheepfold showed in which tab. `simpleBrowser.show` opens VS Code's integrated
 * browser where there is one (1.142: a new tab per call), else Simple Browser's one reused
 * panel. Neither tells an extension the URL a tab shows, so the tab active right after the open
 * is remembered; VS Code keeps one Tab object per tab for its life. A link followed inside the
 * tab, or Simple Browser's panel reused for another page, is not seen; a tab restored by a
 * reload is not known until its row is clicked again.
 */
const tabSessions = new WeakMap<vscode.Tab, Session>();

function sessionInActiveTab(): Session | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  return tab && tabSessions.get(tab);
}

/** `sheepfold.tabSession`: the active tab holds a session page Sheepfold opened. */
function updateTabContext(): void {
  void vscode.commands.executeCommand('setContext', 'sheepfold.tabSession', !!sessionInActiveTab());
}

/**
 * A session's page on the spacesheep site itself, in the browser, whatever `openIn` says. The
 * Session tab signs a message with a passkey for the site's own domain, which a page served
 * from the mirror (`localhost`) can never use: from a tab, the page reads but cannot send
 * (`docs/talk-from-tab-2026-10-16.md`).
 */
async function openInBrowser(s: Session, why = 'asked'): Promise<void> {
  const url = fallbackSessionUrl(s, pageOptions());
  log?.info(`open ${s.sessionId} in the browser (${why}): ${url}`);
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

async function resumeInClaudeCode(sessionId: string): Promise<void> {
  const registered = (await vscode.commands.getCommands(true)).includes(CLAUDE_OPEN_COMMAND);
  if (registered) {
    try {
      await vscode.commands.executeCommand(CLAUDE_OPEN_COMMAND, sessionId);
      return;
    } catch {
      // fall through to the URI handler
    }
  }
  await vscode.env.openExternal(vscode.Uri.parse(claudeCodeUri(vscode.env.uriScheme, sessionId)));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Resume a handed-over session in this window: activate Claude Code, then run its open command,
 * retrying while it starts (`resumeWithRetry`). Polling for the command alone never started the
 * extension, and its own activation (`onStartupFinished` in its 2.1 manifest) can come after a
 * new window's first seconds. An activation that never settles is waited on 10 s at most. The
 * pending file goes only once the command ran; on failure it stays until it expires, so a reload
 * of this window within the two minutes tries again, and the failure is said, not swallowed.
 */
async function runPending(p: PendingOpen): Promise<void> {
  log?.info(`pending open: resuming ${p.sessionId} in ${p.folder}`);
  // Marked as taken, so a second window with the same folder leaves it to this one.
  if (samePending(readPending(os.homedir()), p)) writePending(os.homedir(), { ...p, takenAt: Date.now() });
  const ok = await resumeWithRetry({
    activate: () => Promise.race([Promise.resolve(vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)?.activate()), sleep(10_000)]),
    registered: async () => (await vscode.commands.getCommands(true)).includes(CLAUDE_OPEN_COMMAND),
    run: () => Promise.resolve(vscode.commands.executeCommand(CLAUDE_OPEN_COMMAND, p.sessionId)),
    sleep,
  });
  if (ok) {
    deletePendingIf(os.homedir(), p);
    return;
  }
  // Untaken again, so a reload of this window (or another) can try within the two minutes.
  if (samePending(readPending(os.homedir()), p)) writePending(os.homedir(), { sessionId: p.sessionId, folder: p.folder, at: p.at });
  const installed = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID) !== undefined;
  log?.warn(`pending open: ${p.sessionId} not resumed (Claude Code ${installed ? 'never ran its open command' : 'not found'})`);
  const pick = await vscode.window.showWarningMessage(
    installed
      ? `Claude Code did not start in this window, so session ${p.sessionId.slice(0, 8)} was not resumed.`
      : `Claude Code is not installed or not enabled in this window, so session ${p.sessionId.slice(0, 8)} was not resumed.`,
    'Try again',
  );
  if (pick) await runPending(p);
}

/** Off by default: until the owner turns it on, a click only navigates (Claude Code for a
 * session in this workspace, spacesheep for every other) and never opens windows or writes
 * anything to another host. */
function resumeEnabled(): boolean {
  return vscode.workspace.getConfiguration('sheepfold').get<boolean>('resume', false);
}

// Pending opens this window has started, by session and moment: each is tried once on its own
// (activation or a focus), and "Try again" is the way to repeat it.
const tried = new Set<string>();

/**
 * Runs at activation, before and independent of the first CLI refresh: on a host where the CLI
 * is missing or signed out, resuming still works. `decidePending` reads nothing but the stored
 * value and this window's folders. The value is a file in this host's home, not globalState:
 * that is per profile, and a new window can open in another profile. Runs again whenever this
 * window gains focus: `vscode.openFolder` on a folder already open in another window focuses
 * that window rather than opening one, and nothing activates there.
 */
function resumePending(): void {
  if (!resumeEnabled()) return;
  const home = os.homedir();
  const folders = (vscode.workspace.workspaceFolders ?? []).flatMap((f) => [f.uri.fsPath, f.uri.path]);
  const decision = decidePending(readPending(home), Date.now(), folders);
  if (decision.run) {
    const key = `${decision.run.sessionId}@${decision.run.at}`;
    if (tried.has(key)) return;
    tried.add(key);
    void runPending(decision.run);
  } else if (decision.clear) {
    deletePending(home);
  }
}

/** Whether `target` is one of this window's folders (no new window would open for it). */
function openHere(target: vscode.Uri): boolean {
  // VS Code finds a folder's window ignoring path case except for local files on Linux.
  const ignoreCase = target.scheme !== 'file' || process.platform !== 'linux';
  return (vscode.workspace.workspaceFolders ?? []).some((f) => sameFolder(f.uri, target, ignoreCase));
}

/**
 * Hand the session to the window that is about to open: write the pending file on the host
 * where that window's extension will run (here, or over ssh), then open the folder. If the
 * hand-over fails, say why and offer spacesheep instead of opening a window that cannot resume.
 * The window that takes it may be a new one (it activates) or one that already had the folder
 * open (VS Code focuses it; `resumePending` runs on focus). A folder this window has open needs
 * no hand-over. Whichever window it is, if none took a local hand-over by the time it expires,
 * this window removes it and says so (a remote one expires unseen: reading it costs an ssh).
 */
async function openFolderAndResume(
  s: Session,
  target: vscode.Uri,
  folder: string,
  sshHost: string | null,
): Promise<void> {
  if (openHere(target)) {
    log?.info(`open ${s.sessionId} in a new window: ${folder} is open here, resuming here`);
    await resumeInClaudeCode(s.sessionId);
    return;
  }
  const pending: PendingOpen = { sessionId: s.sessionId, folder, at: Date.now() };
  try {
    if (sshHost) await writePendingOverSsh(sshHost, pending);
    else writePending(os.homedir(), pending);
  } catch (e) {
    const reason = firstLine(e instanceof Error ? e.message : String(e));
    const where = sshHost ? `on ${sshHost} over ssh (a key is needed; ssh runs in batch mode)` : 'in ~/.sheepfold';
    const pick = await vscode.window.showWarningMessage(
      `Could not hand the session over ${where}: ${reason}`,
      'Show on spacesheep',
    );
    if (pick) await showOnSpacesheep(s);
    return;
  }
  try {
    await vscode.commands.executeCommand('vscode.openFolder', target, { forceNewWindow: true });
  } catch (e) {
    if (!sshHost) deletePendingIf(os.homedir(), pending);
    throw e;
  }
  if (!sshHost) watchPending(s, pending);
}

// Cleared when the extension stops, so no expiry check outlives it.
const pendingWatches = new Set<NodeJS.Timeout>();

/**
 * When a local hand-over expires still in place, no window took it (Sheepfold not running
 * there, `sheepfold.resume` off there, or Claude Code failed and that window said so):
 * remove it and offer spacesheep here. Timed from the click, so it looks before the grace in
 * which no other window clears an expired value; a window that took it lately and is still on
 * it (`takenAt` within the hold) is waited for, once more, rather than told over.
 */
function watchPending(s: Session, p: PendingOpen, at = p.at + PENDING_MAX_AGE_MS + 1000): void {
  const timer = setTimeout(() => {
    pendingWatches.delete(timer);
    const q = parsePending(readPending(os.homedir()));
    const now = Date.now();
    if (q && samePending(q, p) && q.takenAt !== undefined && now - q.takenAt >= 0 && now - q.takenAt < PENDING_TAKEN_HOLD_MS) {
      watchPending(s, p, q.takenAt + PENDING_TAKEN_HOLD_MS + 1000);
      return;
    }
    if (!deletePendingIf(os.homedir(), p)) return; // taken and done, or replaced by a newer click
    log?.warn(`pending open: ${p.sessionId} for ${p.folder} expired untaken`);
    void vscode.window
      .showWarningMessage(
        `No window resumed "${sessionLabel(s)}" (${p.folder}) within two minutes. The window for that folder needs Sheepfold with sheepfold.resume on, and Claude Code.`,
        'Show on spacesheep',
      )
      .then((pick) => (pick ? showOnSpacesheep(s) : undefined));
  }, Math.max(0, at - Date.now()));
  pendingWatches.add(timer);
}

type Choice = vscode.QuickPickItem & { action: 'window' | 'spacesheep' };

/** "Open in new window" for a row: a local folder, or the SSH folder on the row's machine. */
async function openInNewWindow(s: Session, c: Classification): Promise<void> {
  if (!resumeEnabled()) return;
  if (c.kind === 'remote') {
    const host = remoteFor(s);
    if (!host) {
      void vscode.window.showInformationMessage(
        `Set sheepfold.remotes for ${s.machine ?? 'this machine'} (sshHost and home) to open it over SSH.`,
      );
      return;
    }
    const parts = sshFolderUri(host, s.cwd);
    await openFolderAndResume(s, vscode.Uri.from(parts), parts.path, host.sshHost);
    return;
  }
  if (c.kind === 'here' || c.kind === 'otherFolder') {
    const folder = c.folder ?? (s.cwd ? expandHome(s.cwd, os.homedir()) : null);
    if (!folder) {
      void vscode.window.showInformationMessage('This session has no folder to open.');
      return;
    }
    await openFolderAndResume(s, vscode.Uri.file(folder), vscode.Uri.file(folder).fsPath, null);
    return;
  }
  if (c.kind === 'noTranscript' || c.kind === 'sdk') await openSession(s, c);
  else void vscode.window.showInformationMessage('This session never got a prompt — nothing to open.');
}

async function openSession(s: Session, c: Classification): Promise<void> {
  log?.info(`click ${s.sessionId} (${s.machine ?? 'no machine'}): ${c.kind}`);
  switch (c.kind) {
    case 'here':
      await resumeInClaudeCode(s.sessionId);
      return;
    case 'otherFolder': {
      if (!resumeEnabled()) {
        await showOnSpacesheep(s);
        return;
      }
      const items: Choice[] = [
        {
          label: `Open ${projectKey(s)} in a new window and resume there`,
          detail: c.folder ?? undefined,
          action: 'window',
        },
        { label: 'Show on spacesheep', action: 'spacesheep' },
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'This session ran in a folder that is not open' });
      if (pick?.action === 'window') await openInNewWindow(s, c);
      else if (pick?.action === 'spacesheep') await showOnSpacesheep(s);
      return;
    }
    case 'remote': {
      if (!resumeEnabled() || !remoteFor(s) || !offersSshResume(c)) {
        await showOnSpacesheep(s); // one option is not a choice
        return;
      }
      const items: Choice[] = [
        { label: `Open on ${s.machine} over SSH and resume there`, action: 'window' },
        { label: 'Show on spacesheep', action: 'spacesheep' },
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: `This session ran on ${s.machine}` });
      if (pick?.action === 'window') await openInNewWindow(s, c);
      else if (pick?.action === 'spacesheep') await showOnSpacesheep(s);
      return;
    }
    case 'noTranscript':
      void vscode.window.showInformationMessage(
        c.cwdGone
          ? "This session's folder was removed, so Claude Code can't resume it here."
          : "This session's transcript isn't on this machine.",
      );
      await showOnSpacesheep(s);
      return;
    case 'sdk':
      // Claude Code would open a blank session for it (see SDK_ENTRYPOINTS); its page shows it.
      await showOnSpacesheep(s);
      return;
    case 'empty':
      void vscode.window.showInformationMessage('This session never got a prompt — nothing to open.');
      return;
  }
}

function sessionOf(arg: unknown): Session | undefined {
  const node = arg as Node | undefined;
  return node && node.kind === 'session' ? node.session : undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  readCli();
  log = vscode.window.createOutputChannel('Sheepfold', { log: true });
  context.subscriptions.push(log);
  void mirrorBase(); // warm the answer the first click needs
  resumePending();
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((e) => {
      if (e.focused) resumePending();
    }),
    { dispose: () => pendingWatches.forEach((t) => clearTimeout(t)) },
  );
  const provider = new SessionsProvider(context.globalState);
  const view = vscode.window.createTreeView('sheepfold.sessions', { treeDataProvider: provider });
  view.description = thisMachine();
  const publishToggles = () =>
    void vscode.commands.executeCommand('setContext', 'sheepfold.showAllInactive', provider.showAllInactive);
  publishToggles();

  let timer: NodeJS.Timeout | undefined;
  let running = false;

  // The nudge: one status-bar item, shown for a while when a session starts needing you or
  // finishes. A click opens that session, or the view when there are several.
  const nudgeItem = vscode.window.createStatusBarItem('sheepfold.nudge', vscode.StatusBarAlignment.Left, 50);
  nudgeItem.name = 'Sheepfold nudges';
  let nudgeTimer: NodeJS.Timeout | undefined;
  const showNudge = (n: Nudge) => {
    nudgeItem.text = nudgeText(n, (s) => provider.label(s));
    nudgeItem.tooltip = n.kind === 'needsYou' ? 'Click to go to it' : 'Finished. Click to go to it';
    nudgeItem.backgroundColor =
      n.kind === 'needsYou' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    nudgeItem.command =
      n.sessions.length === 1
        ? { command: 'sheepfold.openById', title: 'Open Session', arguments: [n.sessions[0].sessionId] }
        : 'sheepfold.sessions.focus';
    nudgeItem.show();
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => nudgeItem.hide(), NUDGE_SECONDS * 1000);
  };

  const publish = () => {
    view.description = thisMachine();
    void vscode.commands.executeCommand('setContext', 'sheepfold.status', provider.status);
    const groups = provider.groupList;
    const { needsYou } = tally(groups);
    const tip = badgeTooltip(needsYou);
    view.badge = tip ? { value: needsYou, tooltip: tip } : undefined;
    view.message = provider.error ?? quietLine(groups) ?? undefined;
    if (provider.nudge && settings().get<boolean>('nudges', true)) showNudge(provider.nudge);
  };
  const refresh = async () => {
    if (running) return;
    running = true;
    try {
      await provider.refresh();
      publish();
    } finally {
      running = false;
    }
  };
  // One timeout at a time, rescheduled after each run, so slow CLI calls never overlap.
  const schedule = () => {
    clearTimeout(timer);
    timer = undefined;
    const seconds = refreshDelaySeconds(settings().get<unknown>('refreshSeconds', 20), view.visible);
    timer = setTimeout(async () => {
      await refresh();
      schedule();
    }, seconds * 1000);
  };

  context.subscriptions.push(
    view,
    nudgeItem,
    { dispose: () => clearTimeout(timer) },
    { dispose: () => clearTimeout(nudgeTimer) },
    view.onDidChangeVisibility(async (e) => {
      // Hidden or shown, the list keeps refreshing (the badge and the nudges need it); showing
      // the view refreshes at once and goes back to the faster interval.
      if (e.visible) {
        await refresh();
      }
      schedule();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sheepfold')) {
        void refresh().then(schedule);
      }
    }),
    vscode.commands.registerCommand('sheepfold.refresh', async () => {
      await refresh();
      schedule();
    }),
    vscode.commands.registerCommand('sheepfold.open', async (arg: unknown) => {
      const s = sessionOf(arg);
      const c = s && provider.classOf(s);
      if (s && c) await openSession(s, c);
    }),
    vscode.commands.registerCommand('sheepfold.openById', async (id: unknown) => {
      nudgeItem.hide();
      const s = provider.sessionById(String(id));
      const c = s && provider.classOf(s);
      if (s && c) await openSession(s, c);
      else await vscode.commands.executeCommand('sheepfold.sessions.focus');
    }),
    vscode.commands.registerCommand('sheepfold.toggleHosts', () => provider.toggleHosts()),
    vscode.commands.registerCommand('sheepfold.toggleInactive', async () => {
      await provider.setShowAllInactive(true);
      publishToggles();
    }),
    vscode.commands.registerCommand('sheepfold.toggleInactiveOff', async () => {
      await provider.setShowAllInactive(false);
      publishToggles();
    }),
    vscode.commands.registerCommand('sheepfold.toggleMore', (arg: unknown) => {
      const node = arg as Node | undefined;
      if (node && node.kind === 'more') provider.toggleMore(node.scope);
    }),
    vscode.commands.registerCommand('sheepfold.openInNewWindow', async (arg: unknown) => {
      const s = sessionOf(arg);
      const c = s && provider.classOf(s);
      if (s && c) await openInNewWindow(s, c);
    }),
    vscode.commands.registerCommand('sheepfold.showOnSpacesheep', async (arg: unknown) => {
      const s = sessionOf(arg);
      if (s) await showOnSpacesheep(s);
    }),
    vscode.commands.registerCommand('sheepfold.openInBrowser', async (arg: unknown) => {
      const s = sessionOf(arg);
      if (s) await openInBrowser(s);
    }),
    vscode.commands.registerCommand('sheepfold.openTabInBrowser', async () => {
      const s = sessionInActiveTab();
      if (s) await openInBrowser(s);
    }),
    vscode.window.tabGroups.onDidChangeTabs(updateTabContext),
    vscode.window.tabGroups.onDidChangeTabGroups(updateTabContext),
    vscode.commands.registerCommand('sheepfold.copySessionId', async (arg: unknown) => {
      const s = sessionOf(arg);
      if (s) await vscode.env.clipboard.writeText(s.sessionId);
    }),
    vscode.commands.registerCommand('sheepfold.openOnClaudeAi', async (arg: unknown) => {
      const s = sessionOf(arg);
      if (s?.url) await vscode.env.openExternal(vscode.Uri.parse(s.url));
    }),
    vscode.commands.registerCommand('sheepfold.revealFolder', async (arg: unknown) => {
      const s = sessionOf(arg);
      if (!s?.cwd) return;
      const folder = expandHome(s.cwd, os.homedir());
      if (!fs.existsSync(folder)) {
        void vscode.window.showWarningMessage(`Folder not found: ${folder}`);
        return;
      }
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(folder));
    }),
  );

  void refresh().then(schedule);
}

export function deactivate(): void {}
