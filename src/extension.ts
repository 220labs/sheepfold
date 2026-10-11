import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  Classification,
  Group,
  MoreRow,
  PendingOpen,
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
  fallbackSessionUrl,
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
  stateMap,
  tally,
  projectKey,
  resolveConfigDir,
  sessionDescription,
  sessionLabel,
  sshFolderUri,
  tooltipFields,
} from './model';
import { ChildLinks, TranscriptIndex, childLinksDir, deletePending, dirExists, readPending, writePending, writePendingOverSsh } from './local';

const CLAUDE_OPEN_COMMAND = 'claude-vscode.editor.open';

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

function localOptions() {
  return { hostname: os.hostname(), localMachines: settings().get<string[]>('localMachines', []) };
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

function runCli(cli: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      expandHome(cli, os.homedir()),
      ['sessions', 'list', '--limit', '100'],
      { timeout: 20_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
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
            local: isLocal(s.machine, hostname, localMachines),
            folders,
            home,
            transcript: (id) => this.index.info(id),
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
    const local = isLocal(s.machine, hostname, localMachines);
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
    item.description = sessionDescription(s, this.now, local, c, this.showHosts ? machineName(s.machine ?? hostname) : null);
    item.iconPath = iconFor(s);
    item.tooltip = tooltipFor(s, c, machineName(hostname), kids.length);
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

function tooltipFor(s: Session, c: Classification | undefined, thisMachine: string, started = 0): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, false);
  md.appendMarkdown(`**${escapeMarkdown(sessionLabel(s, c?.firstUser))}**\n\n`);
  for (const [label, value] of tooltipFields(s, thisMachine)) {
    md.appendMarkdown(`${label}: ${escapeMarkdown(value)}  \n`);
  }
  if (started > 0) md.appendMarkdown(`Started: ${started === 1 ? '1 session' : `${started} sessions`}, nested below  \n`);
  if (c) md.appendMarkdown(`\n${escapeMarkdown(clickHint(c, s, remoteFor(s) !== null, resumeEnabled()))}`);
  return md;
}

let noMirrorNoticeShown = false;

async function probe(base: string): Promise<boolean> {
  try {
    await fetch(base, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

async function showOnSpacesheep(s: Session): Promise<void> {
  const cfg = settings();
  const opts = {
    mirrorUrl: cfg.get<string>('mirrorUrl', 'http://localhost:4280'),
    remoteSessionPath: cfg.get<string>('remoteSessionPath', '/sessions/{source}/{id}'),
  };
  if (await probe(opts.mirrorUrl)) {
    const url = mirrorSessionUrl(s, opts);
    if (cfg.get<string>('remoteOpenIn', 'simpleBrowser') === 'external') {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    } else {
      await vscode.commands.executeCommand('simpleBrowser.show', url);
    }
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(fallbackSessionUrl(s, opts)));
  if (!noMirrorNoticeShown) {
    noMirrorNoticeShown = true;
    void vscode.window.showInformationMessage(
      "spacesheep mirror isn't running — `spacesheep mirror on` (CLI 1.27+) opens sessions inside VS Code.",
    );
  }
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
 * After a window opens for a pending open: run the Claude Code command, retrying while that
 * extension is still starting (up to 5 tries, 1 s apart).
 */
async function runWhenAvailable(sessionId: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    if ((await vscode.commands.getCommands(true)).includes(CLAUDE_OPEN_COMMAND)) {
      try {
        await vscode.commands.executeCommand(CLAUDE_OPEN_COMMAND, sessionId);
        return;
      } catch {
        // not ready yet: try again
      }
    }
    await sleep(1000);
  }
}

/**
 * Runs at activation, before and independent of the first CLI refresh: on a host where the CLI
 * is missing or signed out, resuming still works. `decidePending` reads nothing but the stored
 * value and this window's folders. The value is a file in this host's home, not globalState:
 * that is per profile, and a new window can open in another profile.
 */
/** Off by default: until the owner turns it on, a click only navigates (Claude Code for a
 * session in this workspace, spacesheep for every other) and never opens windows or writes
 * anything to another host. */
function resumeEnabled(): boolean {
  return vscode.workspace.getConfiguration('sheepfold').get<boolean>('resume', false);
}

function resumePending(): void {
  if (!resumeEnabled()) return;
  const home = os.homedir();
  const folders = (vscode.workspace.workspaceFolders ?? []).flatMap((f) => [f.uri.fsPath, f.uri.path]);
  const decision = decidePending(readPending(home), Date.now(), folders);
  if (decision.clear) deletePending(home);
  if (decision.run) void runWhenAvailable(decision.run.sessionId);
}

/**
 * Hand the session to the window that is about to open: write the pending file on the host
 * where that window's extension will run (here, or over ssh), then open the folder. If the
 * hand-over fails, say why and offer spacesheep instead of opening a window that cannot resume.
 */
async function openFolderAndResume(
  s: Session,
  target: vscode.Uri,
  folder: string,
  sshHost: string | null,
): Promise<void> {
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
  await vscode.commands.executeCommand('vscode.openFolder', target, { forceNewWindow: true });
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
    const { uri, path } = sshFolderUri(host, s.cwd);
    await openFolderAndResume(s, vscode.Uri.parse(uri), path, host.sshHost);
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
  if (c.kind === 'noTranscript') await openSession(s, c);
  else void vscode.window.showInformationMessage('This session never got a prompt — nothing to open.');
}

async function openSession(s: Session, c: Classification): Promise<void> {
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
      if (!resumeEnabled() || !remoteFor(s)) {
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
  resumePending();
  const provider = new SessionsProvider(context.globalState);
  const view = vscode.window.createTreeView('sheepfold.sessions', { treeDataProvider: provider });
  view.description = machineName(os.hostname());
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
