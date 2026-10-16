// Pure logic for Sheepfold: parsing the CLI's output, grouping, sorting, local/remote and URL
// building. Never imports `vscode`, so `node --test` covers it without an editor.

export type State = 'needs_you' | 'working' | 'idle' | 'done';

export interface Session {
  source: string | null;
  sessionId: string;
  machine: string | null;
  cwd: string | null;
  repo: string | null;
  branch: string | null;
  model: string | null;
  title: string | null;
  firstAsk: string | null;
  url: string | null;
  state: State;
  lastAt: number;
  lastTool: string | null;
  stale: boolean;
  /** Number of turns the session has had; null when the CLI does not say. */
  turns: number | null;
  /** The session that started this one, as the CLI reports it (sessionpipe's `parent_id`). */
  parentId: string | null;
}

/** A cap-able list: the active rows, the inactive rows that are shown, and the "N more…" row. */
export interface Bucket {
  active: Session[];
  /** Inactive rows shown (idle before done, newest first), after the cap. */
  inactive: Session[];
  /** Inactive rows the cap hides. */
  hidden: number;
  more: MoreRow | null;
}

export type MoreRow = { kind: 'more'; count: number } | { kind: 'fewer' };

export interface Group {
  key: string;
  /** Every visible row of the group, uncapped, in display order (state, then newest). */
  sessions: Session[];
  newest: number;
  /** Rows needing you or working (stale ones excluded). */
  activeCount: number;
  /** A group with no active row starts collapsed. */
  collapsed: boolean;
  description: string;
  /** The interactive rows. */
  interactive: Bucket;
  /** The dispatched rows, nested under one node; null when there are none. */
  dispatched: Bucket | null;
  /** The dispatched node starts expanded when any of its rows is active. */
  dispatchedExpanded: boolean;
  /**
   * Sessions nested under the session that started them, keyed by that session's id, sorted.
   * A nested row is in `sessions` (for the counts) but in no bucket.
   */
  children: ReadonlyMap<string, Session[]>;
}

export interface ListOptions {
  now: number;
  hideDoneAfterHours: number;
  /** Rows this returns true for are left out, so group counts and empty groups follow. */
  exclude?: (s: Session) => boolean;
  /** Inactive rows kept per group (and per dispatched node). Absent: no cap. */
  inactivePerGroup?: number;
  /** Show every inactive row whatever the cap. */
  showAllInactive?: boolean;
  /** Scope keys (`scopeKey`, `dispatchedScopeKey`) whose cap the user lifted. */
  expanded?: ReadonlySet<string>;
  /** Which rows are non-interactive (dispatched) sessions. */
  isDispatched?: (s: Session) => boolean;
  /** The id of the session that started this one (see `readChildLinks`), or null. */
  parentOf?: (s: Session) => string | null;
}

export interface RemoteOptions {
  mirrorUrl: string;
  remoteSessionPath: string;
  /** The spacesheep web app; FALLBACK_BASE unless the CLI is pointed elsewhere. */
  siteOrigin?: string | null;
}

export const STATE_ORDER: readonly State[] = ['needs_you', 'working', 'idle', 'done'];

const STATE_LABEL: Record<State, string> = {
  needs_you: 'needs you',
  working: 'working',
  idle: 'idle',
  done: 'done',
};

export const FALLBACK_BASE = 'https://spacesheep.dev';

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

export function normalizeState(v: unknown): State {
  return typeof v === 'string' && (STATE_ORDER as readonly string[]).includes(v) ? (v as State) : 'idle';
}

/** Parse `spacesheep sessions list` output. Throws a short Error on bad JSON or shape. */
export function parseSessions(text: string): { sessions: Session[]; now: number | null } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('the spacesheep CLI did not return JSON');
  }
  const root = data as { sessions?: unknown; now?: unknown } | null;
  if (!root || typeof root !== 'object' || !Array.isArray(root.sessions)) {
    throw new Error('the spacesheep CLI output has no "sessions" list');
  }
  const sessions: Session[] = [];
  for (const raw of root.sessions) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const sessionId = str(r.session_id);
    if (!sessionId) continue; // nothing to open without an id
    sessions.push({
      source: str(r.source),
      sessionId,
      machine: str(r.machine),
      cwd: str(r.cwd),
      repo: str(r.repo),
      branch: str(r.branch),
      model: str(r.model),
      title: str(r.title),
      firstAsk: str(r.first_ask),
      url: str(r.url),
      state: normalizeState(r.state),
      lastAt: typeof r.last_at === 'number' && Number.isFinite(r.last_at) ? r.last_at : 0,
      lastTool: str(r.last_tool),
      stale: r.stale === true,
      turns: typeof r.turns === 'number' && Number.isFinite(r.turns) ? r.turns : null,
      parentId: str(r.parent_id),
    });
  }
  const now = typeof root.now === 'number' && Number.isFinite(root.now) ? root.now : null;
  return { sessions, now };
}

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== '');
  return parts.length ? parts[parts.length - 1] : '';
}

/** The group a session belongs to: repo name, else cwd (worktree stripped), else `other`. */
export function projectKey(s: Pick<Session, 'repo' | 'cwd'>): string {
  if (s.repo) {
    const seg = lastSegment(s.repo.replace(/\/+$/, '')).replace(/\.git$/, '');
    if (seg) return seg;
  }
  if (s.cwd) {
    const base = s.cwd.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\/\.claude\/worktrees\/[^/]+(\/.*)?$/, '');
    const seg = lastSegment(base);
    if (seg) return seg;
  }
  return 'other';
}

export function compareSessions(a: Session, b: Session): number {
  const d = STATE_ORDER.indexOf(iconState(a)) - STATE_ORDER.indexOf(iconState(b));
  return d !== 0 ? d : b.lastAt - a.lastAt;
}

/** Drop excluded rows and `done` sessions older than the limit (0 keeps all done ones). */
export function visibleSessions(sessions: Session[], opts: ListOptions): Session[] {
  const cutoff = opts.hideDoneAfterHours > 0 ? opts.now - opts.hideDoneAfterHours * 3600_000 : null;
  return sessions.filter((s) => {
    if (opts.exclude?.(s)) return false;
    return cutoff === null || s.state !== 'done' || s.lastAt >= cutoff;
  });
}

/** Needs you or working; a stale session counts as idle. */
export function isActive(s: Pick<Session, 'state' | 'stale'>): boolean {
  const st = iconState(s);
  return st === 'needs_you' || st === 'working';
}

export function groupDescription(sessions: Session[]): string {
  const parts: string[] = [];
  for (const state of STATE_ORDER) {
    if (state === 'done') continue;
    const n = sessions.filter((s) => iconState(s) === state).length;
    if (n > 0) parts.push(`${n} ${STATE_LABEL[state]}`);
  }
  return parts.join(' · ');
}

export const scopeKey = (groupKey: string): string => groupKey;
export const dispatchedScopeKey = (groupKey: string): string => `${groupKey}\u0000dispatched`;

/**
 * Split rows into active and inactive; show every active row, and the inactive ones up to `cap`
 * unless `uncapped`. `more` is the last row: "N more…" while rows are hidden, "show fewer" when
 * the user lifted this scope's cap (`lifted`) and the cap would have hidden something.
 */
export function buildBucket(
  sessions: Session[],
  cap: number,
  opts: { showAll?: boolean; lifted?: boolean; active?: (s: Session) => boolean } = {},
): Bucket {
  const live = opts.active ?? isActive;
  const sorted = [...sessions].sort(compareSessions);
  const active = sorted.filter(live);
  const rest = sorted.filter((s) => !live(s));
  const limit = Math.max(0, Math.floor(cap));
  const uncapped = opts.showAll === true || opts.lifted === true;
  const inactive = uncapped ? rest : rest.slice(0, limit);
  const hidden = rest.length - inactive.length;
  let more: MoreRow | null = null;
  if (hidden > 0) more = { kind: 'more', count: hidden };
  else if (opts.lifted && !opts.showAll && rest.length > limit) more = { kind: 'fewer' };
  return { active, inactive, hidden, more };
}

/** How far `rootOf` follows parent links before it gives up (a chain of dispatch steps). */
const MAX_PARENT_DEPTH = 32;

/**
 * The topmost visible ancestor of a session, following `parentOf` while the parent is visible.
 * A chain of dispatched steps (a → b → c) flattens under `a`; a hidden parent ends the walk, so
 * a session whose starter is not listed stays where it would be without links. Cycles stop.
 */
export function rootOf(s: Session, byId: ReadonlyMap<string, Session>, parentOf: (s: Session) => string | null): Session {
  let cur = s;
  const seen = new Set<string>([s.sessionId]);
  for (let i = 0; i < MAX_PARENT_DEPTH; i++) {
    const pid = parentOf(cur);
    const p = pid ? byId.get(pid) : undefined;
    if (!p || seen.has(p.sessionId)) break;
    seen.add(p.sessionId);
    cur = p;
  }
  return cur;
}

/** Nested sessions per top-level row: child id → its root, for every visible row with one. */
export function nestChildren(visible: Session[], parentOf?: (s: Session) => string | null): Map<string, Session[]> {
  const kids = new Map<string, Session[]>();
  if (!parentOf) return kids;
  const byId = new Map(visible.map((s) => [s.sessionId, s]));
  for (const s of visible) {
    const root = rootOf(s, byId, parentOf);
    if (root === s) continue;
    // rootOf stopped early (a cycle, or a chain past MAX_PARENT_DEPTH): its root is nested itself,
    // so nesting under it would drop the row from the tree. It stays a top-level row instead.
    const above = parentOf(root);
    if (above && above !== root.sessionId && byId.has(above)) continue;
    const list = kids.get(root.sessionId);
    if (list) list.push(s);
    else kids.set(root.sessionId, [s]);
  }
  for (const list of kids.values()) list.sort(compareSessions);
  return kids;
}

export function groupSessions(sessions: Session[], opts: ListOptions): Group[] {
  const visible = visibleSessions(sessions, opts);
  const kids = nestChildren(visible, opts.parentOf);
  const nested = new Set<string>();
  for (const list of kids.values()) for (const k of list) nested.add(k.sessionId);
  // A row that started a session needing you or working counts as active: it must stay in view.
  const live = (s: Session): boolean => isActive(s) || (kids.get(s.sessionId)?.some(isActive) ?? false);

  const byKey = new Map<string, Session[]>();
  for (const s of visible) {
    if (nested.has(s.sessionId)) continue;
    const key = projectKey(s);
    const list = byKey.get(key);
    if (list) list.push(s);
    else byKey.set(key, [s]);
  }
  const cap = opts.inactivePerGroup ?? Infinity;
  const showAll = opts.showAllInactive === true;
  const groups: Group[] = [];
  for (const [key, list] of byKey) {
    list.sort(compareSessions);
    const isD = opts.isDispatched ?? (() => false);
    const dispatchedRows = list.filter(isD);
    const interactiveRows = list.filter((s) => !isD(s));
    const dispatched = dispatchedRows.length
      ? buildBucket(dispatchedRows, cap, { showAll, lifted: opts.expanded?.has(dispatchedScopeKey(key)), active: live })
      : null;
    // Counts and the active sort take the nested rows too: they show inside this group.
    const children = new Map<string, Session[]>();
    for (const s of list) {
      const k = kids.get(s.sessionId);
      if (k) children.set(s.sessionId, k);
    }
    const all = [...list, ...[...children.values()].flat()].sort(compareSessions);
    groups.push({
      key,
      sessions: all,
      newest: Math.max(...all.map((s) => s.lastAt)),
      activeCount: all.filter(isActive).length,
      collapsed: !all.some(isActive),
      description: groupDescription(all),
      interactive: buildBucket(interactiveRows, cap, { showAll, lifted: opts.expanded?.has(scopeKey(key)), active: live }),
      dispatched,
      dispatchedExpanded: dispatched !== null && dispatched.active.length > 0,
      children,
    });
  }
  // Groups with active rows first (most active, then newest), then the rest by newest.
  groups.sort((a, b) => {
    const aa = a.activeCount > 0 ? 1 : 0;
    const ba = b.activeCount > 0 ? 1 : 0;
    return ba - aa || b.activeCount - a.activeCount || b.newest - a.newest || a.key.localeCompare(b.key);
  });
  return groups;
}

export type LayoutItem =
  | { kind: 'session'; session: Session }
  | { kind: 'dispatched'; count: number; expanded: boolean }
  | { kind: 'more'; more: MoreRow; scope: string };

/**
 * A group's children in display order: interactive active rows, the dispatched node, the capped
 * interactive inactive rows, then "N more…".
 */
export function groupLayout(g: Group): LayoutItem[] {
  const out: LayoutItem[] = g.interactive.active.map((session) => ({ kind: 'session', session }));
  if (g.dispatched) {
    const d = g.dispatched;
    out.push({
      kind: 'dispatched',
      count: d.active.length + d.inactive.length + d.hidden,
      expanded: g.dispatchedExpanded,
    });
  }
  for (const session of g.interactive.inactive) out.push({ kind: 'session', session });
  if (g.interactive.more) out.push({ kind: 'more', more: g.interactive.more, scope: scopeKey(g.key) });
  return out;
}

/** The dispatched node's children: active rows, capped inactive rows, "N more…". */
export function dispatchedLayout(g: Group): LayoutItem[] {
  const d = g.dispatched;
  if (!d) return [];
  const out: LayoutItem[] = [...d.active, ...d.inactive].map((session) => ({ kind: 'session', session }));
  if (d.more) out.push({ kind: 'more', more: d.more, scope: dispatchedScopeKey(g.key) });
  return out;
}

/** A nested row's children: the sessions it started, active first. */
export function childLayout(g: Group, sessionId: string): LayoutItem[] {
  return (g.children.get(sessionId) ?? []).map((session) => ({ kind: 'session', session }));
}

/** Text of a "more" row. */
export function moreLabel(m: MoreRow): string {
  return m.kind === 'more' ? `${m.count} more in the fold…` : 'show fewer';
}

// ---------------------------------------------------------------------------------------------
// The view's summary: the activity-bar badge, the line over the list, and nudges on change.

/** Rows needing you and working, over every group (nested rows included). */
export function tally(groups: readonly Group[]): { needsYou: number; working: number } {
  let needsYou = 0;
  let working = 0;
  for (const g of groups) {
    for (const s of g.sessions) {
      const st = iconState(s);
      if (st === 'needs_you') needsYou++;
      else if (st === 'working') working++;
    }
  }
  return { needsYou, working };
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The badge's tooltip; null when nothing needs you (no badge). */
export function badgeTooltip(needsYou: number): string | null {
  return needsYou > 0 ? `${plural(needsYou, 'session needs', 'sessions need')} you` : null;
}

/**
 * The line over the list when nothing needs you (the badge covers the other case): what is
 * still working, or that all is quiet. Null when something needs you or there is no list.
 */
export function quietLine(groups: readonly Group[]): string | null {
  if (groups.length === 0) return null;
  const { needsYou, working } = tally(groups);
  if (needsYou > 0) return null;
  return working > 0 ? `Nothing needs you · ${working} working` : 'All quiet in the fold: nothing needs you.';
}

export type NudgeKind = 'needsYou' | 'finished';

export interface Nudge {
  kind: NudgeKind;
  sessions: Session[];
}

/**
 * Sessions that just started needing you, or just finished, since the previous refresh. Only
 * a row seen before with another state counts: the first load nudges nothing, and a row that
 * was already waiting does not nudge again. Needing you wins over finishing.
 */
export function nudgeFor(previous: ReadonlyMap<string, State>, sessions: readonly Session[]): Nudge | null {
  const needs: Session[] = [];
  const finished: Session[] = [];
  for (const s of sessions) {
    const before = previous.get(s.sessionId);
    const now = iconState(s);
    if (before === undefined) {
      // New since the last refresh and already waiting (a step that hit a prompt within one
      // refresh). The first load has an empty map and nudges nothing.
      if (previous.size > 0 && now === 'needs_you') needs.push(s);
      continue;
    }
    if (now === before) continue;
    if (now === 'needs_you') needs.push(s);
    else if (before === 'working' && now === 'done') finished.push(s);
  }
  if (needs.length) return { kind: 'needsYou', sessions: needs };
  if (finished.length) return { kind: 'finished', sessions: finished };
  return null;
}

/** The state each row shows, for the next `nudgeFor`. */
export function stateMap(sessions: readonly Session[]): Map<string, State> {
  return new Map(sessions.map((s) => [s.sessionId, iconState(s)]));
}

/** The status-bar text of a nudge (codicon syntax); `label` names a session. */
export function nudgeText(n: Nudge, label: (s: Session) => string): string {
  const one = n.sessions.length === 1 ? oneLine(label(n.sessions[0]), 48) : null;
  if (n.kind === 'needsYou') {
    return one ? `$(bell) Baa, ${one} needs you` : `$(bell) Baa, ${n.sessions.length} sessions need you`;
  }
  return one ? `$(check) Back in the fold: ${one}` : `$(check) ${n.sessions.length} sessions back in the fold`;
}

// ---------------------------------------------------------------------------------------------
// Dispatched (non-interactive) sessions, and machine names.

/**
 * Default for `sheepfold.dispatchedTitlePattern`: off. Titles are the user's own, so no
 * convention can be assumed; the transcript's `sdk-cli` entrypoint marks dispatched rows anyway.
 */
export const DEFAULT_DISPATCHED_PATTERN = '';

/** The README's example: titles like "repo: topic · host", as one launcher names its runs. */
export const EXAMPLE_DISPATCHED_PATTERN = '\\s·\\s\\S+$';

/** A user-given regex source, or null when it is empty or invalid. */
export function compileDispatchedPattern(source: string | null | undefined): RegExp | null {
  if (!source) return null;
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

/**
 * Dispatched when the transcript's entrypoint is `sdk-cli`, or the title matches the pattern.
 * A remote row has no transcript here, so only the title can say.
 */
export function isDispatched(entrypoint: string | null, title: string | null, pattern: RegExp | null): boolean {
  if (entrypoint === 'sdk-cli') return true;
  return Boolean(pattern && title && pattern.test(title));
}

/** The suffixes the spacesheep CLI drops from a hostname when it names the machine. */
const HOST_SUFFIX = /\.(local|lan|home)$/i;

/** This machine's name as shown: the name the CLI reports under, else the hostname as it trims it. */
export function machineName(hostname: string, cliMachine?: string | null): string {
  return cliMachine || hostname.replace(HOST_SUFFIX, '');
}

/** One line, whitespace collapsed, at most `max` characters. */
export function oneLine(text: string, max = 60): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Title, else the first ask, else (local rows) the first real user message of the transcript,
 * else the first 8 characters of the id.
 */
export function sessionLabel(s: Session, transcriptFirstUser?: string | null): string {
  if (s.title) return s.title;
  if (s.firstAsk) return s.firstAsk.slice(0, 60);
  const t = transcriptFirstUser ? oneLine(transcriptFirstUser) : '';
  return t || s.sessionId.slice(0, 8);
}

/**
 * Seconds until the next refresh. The badge and the nudges need the list while the view is
 * hidden too, so a hidden view still polls, at most once a minute. A setting that is not a
 * finite number (a string in settings.json) counts as the default, never as NaN.
 */
export function refreshDelaySeconds(setting: unknown, visible: boolean): number {
  const base = typeof setting === 'number' && Number.isFinite(setting) ? Math.max(5, setting) : 20;
  return visible ? base : Math.max(base, 60);
}

/** `now`, `3m`, `2h`, `yesterday`, `5d`. */
export function relativeTime(lastAt: number, now: number): string {
  const ms = Math.max(0, now - lastAt);
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 2 ? 'yesterday' : `${days}d`;
}

function stripLocalSuffix(name: string): string {
  return name.replace(HOST_SUFFIX, '').toLowerCase();
}

/**
 * A session is local when its machine is this host (ignoring a `.local` suffix and case) or is
 * listed in `localMachines`. A session that names no machine cannot be told apart, so it counts
 * as local: the Claude Code extension is the only opener that can try it.
 */
export function isLocal(
  machine: string | null,
  hostname: string,
  localMachines: readonly string[],
  cliMachine?: string | null,
): boolean {
  if (!machine) return true;
  const m = stripLocalSuffix(machine);
  if (m === stripLocalSuffix(hostname)) return true;
  if (cliMachine && m === stripLocalSuffix(cliMachine)) return true;
  return localMachines.some((l) => stripLocalSuffix(l) === m);
}

/** The icon id a session shows; a stale session looks idle whatever its state says. */
export function iconState(s: Pick<Session, 'state' | 'stale'>): State {
  return s.stale ? 'idle' : s.state;
}

export function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/') || path.startsWith('~\\')) return home.replace(/[\\/]+$/, '') + path.slice(1);
  return path;
}

/**
 * A path for comparing: forward slashes, no trailing slash, and a Windows drive path in lower
 * case (its file system ignores case, and VS Code and Claude Code disagree on the drive letter's).
 */
export function normPath(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
  return /^[a-zA-Z]:(\/|$)/.test(s) ? s.toLowerCase() : s;
}

/** A folder URI as parts: what `vscode.Uri` carries, without importing vscode. */
export interface FolderParts {
  scheme: string;
  authority: string;
  path: string;
}

/**
 * Whether two folder URIs name the same folder: scheme exact, authority without case, path
 * through `normPath` (a URI path spells a Windows drive as `/C:/x` or `/c:/x`), and without case
 * at all when `ignoreCase` (as VS Code matches a folder to its window: always, but for local
 * files on Linux).
 */
export function sameFolder(a: FolderParts, b: FolderParts, ignoreCase = false): boolean {
  const path = (p: string) => {
    const n = normPath(p.replace(/^\/([a-zA-Z]:)/, '$1'));
    return ignoreCase ? n.toLowerCase() : n;
  };
  return a.scheme === b.scheme && a.authority.toLowerCase() === b.authority.toLowerCase() && path(a.path) === path(b.path);
}

/** Whether `cwd` is one of the workspace folders or inside one. */
export function isInsideFolders(cwd: string, folders: readonly string[], home: string): boolean {
  const norm = (p: string) => normPath(expandHome(p, home));
  const c = norm(cwd);
  return folders.some((f) => {
    const n = norm(f);
    return c === n || c.startsWith(n + '/');
  });
}

function fill(template: string, s: Pick<Session, 'source' | 'sessionId' | 'machine'>): string {
  const sub: Record<string, string> = {
    source: s.source ?? '',
    id: s.sessionId,
    machine: s.machine ?? '',
  };
  return template.replace(/\{(source|id|machine)\}/g, (_, k: string) => encodeURIComponent(sub[k]));
}

function joinUrl(base: string, path: string): string {
  const p = path.startsWith('/') ? path : '/' + path;
  return base.replace(/\/+$/, '') + p;
}

/** The session's URL on the local mirror. */
export function mirrorSessionUrl(s: Pick<Session, 'source' | 'sessionId' | 'machine'>, o: RemoteOptions): string {
  return joinUrl(o.mirrorUrl, fill(o.remoteSessionPath, s));
}

/** The same path on the spacesheep site itself. */
export function fallbackSessionUrl(s: Pick<Session, 'source' | 'sessionId' | 'machine'>, o: RemoteOptions): string {
  return joinUrl(o.siteOrigin || FALLBACK_BASE, fill(o.remoteSessionPath, s));
}

/**
 * The mirror's base URL from `spacesheep mirror status --json`: `{ pid, port, site, ... }` while
 * one runs, `{ running: false }` when none does. A mirror of another site (a dev server) does
 * not count, and the port is read, never assumed. Null for anything else.
 */
export function mirrorFromStatus(text: string, site: string): string | null {
  try {
    const s = JSON.parse(text) as { port?: unknown; site?: unknown; running?: unknown } | null;
    if (!s || s.running === false) return null;
    if (typeof s.site !== 'string' || s.site.replace(/\/+$/, '') !== site.replace(/\/+$/, '')) return null;
    const port = s.port;
    return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? `http://localhost:${port}` : null;
  } catch {
    return null;
  }
}

/**
 * `sheepfold.openIn` as it applies: `browser` or `editor`, and while openIn is set nowhere, the
 * deprecated `remoteOpenIn: external` still means the browser.
 */
export function resolveOpenIn(openIn: { explicit: unknown; effective: unknown }, remoteOpenIn: unknown): 'editor' | 'browser' {
  if (openIn.explicit === undefined && remoteOpenIn === 'external') return 'browser';
  return openIn.effective === 'browser' ? 'browser' : 'editor';
}

/** The Claude Code extension's URI-handler form of "open this session". */
export function claudeCodeUri(scheme: string, sessionId: string): string {
  return `${scheme}://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`;
}

/** First non-empty line of the CLI's stderr, for the welcome message. */
export function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

/** Markdown-safe text for a tooltip value. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}\[\]()#+\-.!|<>~]/g, '\\$&');
}

/** The tooltip as label/value pairs; the extension renders them as Markdown. */
export function tooltipFields(s: Session, fallbackMachine?: string | null): Array<[string, string]> {
  const fields: Array<[string, string | null]> = [
    ['State', s.stale ? `${STATE_LABEL[s.state]} (stale)` : STATE_LABEL[s.state]],
    ['Machine', s.machine ?? fallbackMachine ?? null],
    ['Folder', s.cwd],
    ['Branch', s.branch],
    ['Model', s.model],
    ['Last tool', s.lastTool],
  ];
  return fields.filter((f): f is [string, string] => f[1] !== null);
}

/**
 * `3m`, then the openability hint: `3m ↗ app`, `3m ⇄ other-machine`, `3m no transcript`.
 * Without a classification, only a remote machine is hinted (the v0.1 form).
 */
export function sessionDescription(
  s: Session,
  now: number,
  local: boolean,
  c?: Classification,
  host?: string | null,
): string {
  const t = relativeTime(s.lastAt, now);
  const hint = c ? openHint(c, s) : !local && s.machine ? `⇄ ${s.machine}` : '';
  const parts = [t];
  if (hint) parts.push(hint);
  // A remote row's hint already names its machine; `host` is the toggle's name for the others.
  if (host && !hint.startsWith('⇄')) parts.push(`@${host}`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------------------------
// Openability: can a click on this row open something, and what.

export type Openability = 'here' | 'otherFolder' | 'remote' | 'empty' | 'noTranscript' | 'sdk';

/**
 * Entrypoints of sessions run through an Agent SDK. Claude Code's session list leaves these out
 * (its extension 2.1.299 filters the same three), and its open command, handed an id it does not
 * list, starts a blank session instead of failing — so a click on one must not go there.
 * Plain `claude -p` runs are `sdk-cli` too. The same filter also drops a `sessionKind` of `daemon`
 * or `daemon-worker`; those are not read here yet (none seen in real transcripts, 2026-10-14).
 */
export const SDK_ENTRYPOINTS: ReadonlySet<string> = new Set(['sdk-cli', 'sdk-ts', 'sdk-py']);

export interface Classification {
  kind: Openability;
  /** otherFolder: the session's own folder no longer exists (a removed worktree). */
  cwdGone: boolean;
  /** otherFolder: the folder to open (the cwd, or the repo root when the cwd is gone). */
  folder: string | null;
  /** The first real user message of the local transcript, for a nameless row's label. */
  firstUser: string | null;
  /** Non-interactive session (see `isDispatched`). */
  dispatched: boolean;
}

/**
 * Whether a remote row may offer "open over SSH and resume there". A dispatched row most likely
 * ran through an SDK, which Claude Code over there would open blank; its transcript is not here
 * to say for sure, so it goes to spacesheep.
 */
export function offersSshResume(c: Pick<Classification, 'kind' | 'dispatched'>): boolean {
  return c.kind === 'remote' && !c.dispatched;
}

/** What is known about a session's transcript file on this machine. */
export interface TranscriptInfo {
  found: boolean;
  /** At least one user line that is not meta. */
  hasUser: boolean;
  firstUser: string | null;
  /** The `entrypoint` of the first transcript line that carries one (`cli`, `sdk-cli`, ...). */
  entrypoint?: string | null;
}

/** The filesystem side of `classify`, injected so the logic stays pure. */
export interface ClassifyContext {
  /** Whether the row's machine is this one (see `isLocal`). */
  local: boolean;
  /** Open workspace folders (local paths). */
  folders: readonly string[];
  home: string;
  /** The transcript of a session; `cwd` (home expanded, or null) lets it look in one place first. */
  transcript: (sessionId: string, cwd: string | null) => TranscriptInfo;
  dirExists: (path: string) => boolean;
  /** Compiled `sheepfold.dispatchedTitlePattern`. */
  dispatchedPattern?: RegExp | null;
}

/** `<root>/.claude/worktrees/<x>[/...]` → `<root>`; any other path unchanged (no trailing slash). */
export function repoRoot(path: string): string {
  // Either separator, the path's own case: the result is a folder to open, not only a key.
  return path.replace(/(.)[\\/]+$/, '$1').replace(/[\\/]\.claude[\\/]worktrees[\\/][^\\/]+([\\/].*)?$/, '');
}

const NO_TRANSCRIPT: TranscriptInfo = { found: false, hasUser: false, firstUser: null };

function result(kind: Openability, extra: Partial<Classification> = {}): Classification {
  return { kind, cwdGone: false, folder: null, firstUser: null, dispatched: false, ...extra };
}

/**
 * Decide what a click on a row can do. Order matters:
 *  1. Nothing to show or open: no turns, no title, no first ask → `empty` (any machine).
 *  2. Another machine → `remote`.
 *  3. This machine, by the transcript:
 *     none → `noTranscript` (or `empty` when the row has no title, ask or turns either);
 *     no user message → `empty`;
 *     run through an SDK (`SDK_ENTRYPOINTS`) → `sdk`, wherever its cwd is;
 *     cwd exists and is inside an open folder (or is one) → `here`;
 *     cwd exists outside them → `otherFolder`;
 *     cwd removed: inside an open folder → `noTranscript` (a removed worktree opens blank);
 *     outside → `otherFolder` at the repo root when that exists, else `noTranscript`.
 * A local row without a cwd cannot be placed; it counts as `here` (the extension may still try).
 */
export function classify(s: Session, ctx: ClassifyContext): Classification {
  let entrypoint: string | null = null;
  const c = classifyOpen(s, ctx, (e) => (entrypoint = e));
  return { ...c, dispatched: isDispatched(entrypoint, s.title, ctx.dispatchedPattern ?? null) };
}

function classifyOpen(s: Session, ctx: ClassifyContext, seenEntrypoint: (e: string | null) => void): Classification {
  const named = Boolean(s.title || s.firstAsk);
  if (s.turns === 0 && !named) return result('empty');
  if (!ctx.local) return result('remote');

  const t = ctx.transcript(s.sessionId, s.cwd ? expandHome(s.cwd, ctx.home) : null) ?? NO_TRANSCRIPT;
  seenEntrypoint(t.entrypoint ?? null);
  if (!t.found) {
    return named || (s.turns ?? 0) > 0 ? result('noTranscript') : result('empty');
  }
  if (!t.hasUser) return result('empty');
  const firstUser = t.firstUser;
  if (t.entrypoint && SDK_ENTRYPOINTS.has(t.entrypoint)) return result('sdk', { firstUser });

  if (!s.cwd) return result('here', { firstUser });
  // `cwd` keeps its own case and separators (it is opened); `key` is for comparing.
  const cwd = expandHome(s.cwd, ctx.home).replace(/(.)[\\/]+$/, '$1');
  const key = normPath(cwd);
  const inside = isInsideFolders(cwd, ctx.folders, ctx.home);
  const exactFolder = ctx.folders.some((f) => normPath(expandHome(f, ctx.home)) === key);
  // Claude Code only probes worktrees git still lists, so a removed one opens blank: `here`
  // needs the cwd to exist (an open workspace folder itself is taken as existing).
  if (exactFolder) return result('here', { firstUser, folder: cwd });
  if (ctx.dirExists(cwd)) return result(inside ? 'here' : 'otherFolder', { firstUser, folder: cwd });
  if (inside) return result('noTranscript', { firstUser, cwdGone: true });

  const root = repoRoot(cwd);
  if (normPath(root) !== key && ctx.dirExists(root)) {
    return result('otherFolder', { firstUser, folder: root, cwdGone: true });
  }
  return result('noTranscript', { firstUser, cwdGone: true });
}

function goneLabel(s: Pick<Session, 'cwd'>): string {
  return s.cwd && normPath(repoRoot(s.cwd)) !== normPath(s.cwd) ? 'worktree removed' : 'folder removed';
}

/** The hint after the time in a row's description. */
export function openHint(c: Classification, s: Pick<Session, 'repo' | 'cwd' | 'machine'>): string {
  switch (c.kind) {
    case 'otherFolder':
      return `↗ ${projectKey(s)}`;
    case 'remote':
      return s.machine ? `⇄ ${s.machine}` : '';
    case 'noTranscript':
      return c.cwdGone ? goneLabel(s) : 'no transcript';
    case 'sdk':
      return 'SDK';
    default:
      return '';
  }
}

/** One line for the tooltip: what a click will do. */
export function clickHint(
  c: Classification,
  s: Pick<Session, 'repo' | 'cwd' | 'machine'>,
  canSsh: boolean,
  resume = true,
): string {
  switch (c.kind) {
    case 'here':
      return 'Click: open in Claude Code.';
    case 'otherFolder':
      return resume
        ? `Click: open ${projectKey(s)} in a new window and resume there, or show on spacesheep.`
        : 'Click: show on spacesheep (the folder is not open here).';
    case 'remote':
      return canSsh && resume
        ? `Click: open on ${s.machine} over SSH and resume there, or show on spacesheep.`
        : 'Click: show on spacesheep.';
    case 'noTranscript':
      return c.cwdGone
        ? `Click: show on spacesheep (the ${goneLabel(s).replace(' removed', '')} was removed, so Claude Code cannot resume it).`
        : "Click: show on spacesheep (the transcript isn't on this machine).";
    case 'sdk':
      return 'Click: show on spacesheep (it ran through the SDK, and Claude Code cannot open SDK sessions).';
    case 'empty':
      return 'This session never got a prompt; nothing to open.';
  }
}

/** Hide empty rows unless the user asked to see them. */
export function excludeEmpty(classes: ReadonlyMap<string, Classification>, showEmpty: boolean) {
  return (s: Session): boolean => !showEmpty && classes.get(s.sessionId)?.kind === 'empty';
}

// ---------------------------------------------------------------------------------------------
// Transcript lookup: where Claude Code keeps its config.

export interface ConfigDirInputs {
  /** `sheepfold.claudeConfigDir`: wins when set. */
  setting?: string | null;
  /** `claudeCode.environmentVariables`: an array of { name, value }. */
  claudeCodeEnv?: unknown;
  /** The process environment's CLAUDE_CONFIG_DIR. */
  processEnv?: string | null;
  home: string;
}

/** Setting, else the Claude Code extension's own env entry, else the process env, else `~/.claude`. */
export function resolveConfigDir(i: ConfigDirInputs): string {
  const pick = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  let dir = pick(i.setting);
  if (!dir && Array.isArray(i.claudeCodeEnv)) {
    for (const e of i.claudeCodeEnv) {
      const entry = e as { name?: unknown; value?: unknown } | null;
      if (entry && entry.name === 'CLAUDE_CONFIG_DIR') {
        dir = pick(entry.value);
        if (dir) break;
      }
    }
  }
  dir = dir ?? pick(i.processEnv) ?? '~/.claude';
  return expandHome(dir, i.home).replace(/\/+$/, '') || '/';
}

// ---------------------------------------------------------------------------------------------
// Opening on another machine over SSH, and resuming after a window reload.

export interface RemoteHost {
  sshHost: string;
  home: string;
}

/** The `sheepfold.remotes` entry for a machine (case and `.local` ignored), if well formed. */
export function findRemote(remotes: unknown, machine: string | null): RemoteHost | null {
  if (!machine || !remotes || typeof remotes !== 'object') return null;
  const want = stripLocalSuffix(machine);
  for (const [name, v] of Object.entries(remotes as Record<string, unknown>)) {
    if (stripLocalSuffix(name) !== want) continue;
    const e = v as { sshHost?: unknown; home?: unknown } | null;
    if (e && typeof e.sshHost === 'string' && e.sshHost.trim() && typeof e.home === 'string' && e.home.trim()) {
      return { sshHost: e.sshHost.trim(), home: e.home.trim() };
    }
  }
  return null;
}

/** A session's folder on the remote machine: `~` is the configured home; relative paths hang off it. */
export function remotePath(home: string, cwd: string | null): string {
  const h = home.replace(/\/+$/, '') || '';
  if (!cwd || cwd === '~') return h || '/';
  if (cwd.startsWith('~/')) return h + cwd.slice(1);
  if (cwd.startsWith('/')) return cwd;
  return `${h}/${cwd}`;
}

/**
 * The parts of `vscode-remote://ssh-remote+<host><path>` for a session's folder on another
 * machine, for `vscode.Uri.from`: built from parts, a `#`, `?` or `%` in the path stays part of
 * the path, where a string through `Uri.parse` would end it or decode it. A URI with an
 * authority needs a path that starts with `/` (Uri.from throws otherwise), so a relative `home`
 * gets one.
 */
export function sshFolderUri(host: RemoteHost, cwd: string | null): { scheme: 'vscode-remote'; authority: string; path: string } {
  const p = remotePath(host.home, cwd);
  return { scheme: 'vscode-remote', authority: `ssh-remote+${host.sshHost}`, path: p.startsWith('/') ? p : `/${p}` };
}

export interface PendingOpen {
  sessionId: string;
  /** The folder the new window will have open (a local path, or a path on the remote host). */
  folder: string;
  /** Unix ms when it was stored. */
  at: number;
  /** Unix ms when a window took it; until it is done or fails, no other window runs it too. */
  takenAt?: number;
}

export const PENDING_MAX_AGE_MS = 120_000;
/** How long a taken hand-over is left to the window that took it (activation and polling: ~20 s). */
export const PENDING_TAKEN_HOLD_MS = 45_000;
/**
 * How long an expired hand-over stays before any window clears it: the clicking window looks
 * at `PENDING_MAX_AGE_MS + 1000` to say none took it, and a window focused in between must not
 * delete the file first and silence that warning.
 */
export const PENDING_CLEAR_GRACE_MS = 5_000;

export function parsePending(v: unknown): PendingOpen | null {
  const p = v as Partial<PendingOpen> | null;
  if (!p || typeof p !== 'object') return null;
  if (typeof p.sessionId !== 'string' || !p.sessionId) return null;
  if (typeof p.folder !== 'string' || !p.folder) return null;
  if (typeof p.at !== 'number' || !Number.isFinite(p.at)) return null;
  const q: PendingOpen = { sessionId: p.sessionId, folder: p.folder, at: p.at };
  if (typeof p.takenAt === 'number' && Number.isFinite(p.takenAt)) q.takenAt = p.takenAt;
  return q;
}

function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/**
 * A pending open applies to a window when it is under two minutes old (and not from the future)
 * and its folder is one of the window's workspace folders. `windowFolders` carries both the
 * `fsPath` and the remote `path` of each folder.
 */
export function pendingMatches(p: PendingOpen, now: number, windowFolders: readonly string[]): boolean {
  const age = now - p.at;
  if (age < 0 || age >= PENDING_MAX_AGE_MS) return false;
  // Lowercased, because VS Code focuses the window for a folder whatever its case (a Windows
  // drive letter, a case-insensitive disk); a hand-over its focus handler then missed would
  // never fire. On Linux, where `/srv/App` and `/srv/app` are two windows, a focused `/srv/App`
  // window could take one meant for `/srv/app`: rare, and the session still opens.
  const key = (f: string) => trimSlash(normPath(f)).toLowerCase();
  const want = key(p.folder);
  return windowFolders.some((f) => key(f) === want);
}

export interface PendingDecision {
  /** The session to open in this window now, if any. */
  run: PendingOpen | null;
  /** Whether the stored value should be removed now (expired or unreadable). A value to run is
   * kept: the window removes it once the session opened (`deletePendingIf`). */
  clear: boolean;
}

/**
 * What a window should do with the stored pending open at activation. It takes only the stored
 * value, the clock and this window's folders: no CLI output, no session list. Resuming must work
 * on a host where the spacesheep CLI is missing or not signed in, and before any refresh.
 * A value for another window's folder stays until it expires or that window takes it.
 */
export function decidePending(raw: unknown, now: number, windowFolders: readonly string[]): PendingDecision {
  if (raw === undefined) return { run: null, clear: false }; // nothing stored; null = unreadable
  const p = parsePending(raw);
  if (!p) return { run: null, clear: true };
  const age = now - p.at;
  if (age < 0) return { run: null, clear: true };
  if (age >= PENDING_MAX_AGE_MS) return { run: null, clear: age >= PENDING_MAX_AGE_MS + PENDING_CLEAR_GRACE_MS };
  if (p.takenAt !== undefined && now - p.takenAt >= 0 && now - p.takenAt < PENDING_TAKEN_HOLD_MS) {
    return { run: null, clear: false }; // another window is on it
  }
  return pendingMatches(p, now, windowFolders) ? { run: p, clear: false } : { run: null, clear: false };
}

/** Whether a stored value is still this pending open (same session, same moment). */
export function samePending(raw: unknown, p: PendingOpen): boolean {
  const q = parsePending(raw);
  return q !== null && q.sessionId === p.sessionId && q.at === p.at && q.folder === p.folder;
}

/** The parts of the VS Code API `resumeWithRetry` drives, injected so it runs under `node --test`. */
export interface ResumeSteps {
  /** Start the Claude Code extension (`Extension.activate()`); throws or rejects when it can't. */
  activate: () => Promise<unknown>;
  /** Whether its open command is registered yet. */
  registered: () => Promise<boolean>;
  /** Run that command for the session; rejects when it fails. */
  run: () => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Resume a session handed over to this window: activate Claude Code first (waiting for its
 * command alone never starts it: nothing else in a fresh window may), then run its open
 * command, retrying while the command is not registered yet or fails. Resolves true once the
 * command ran, false when every try failed; never throws, so the caller can say why.
 */
export async function resumeWithRetry(steps: ResumeSteps, tries = 10, delayMs = 1000): Promise<boolean> {
  try {
    await steps.activate();
  } catch {
    // not installed in this extension host, or its activation failed: the command may still
    // come from another host, so poll for it anyway
  }
  for (let i = 0; i < tries; i++) {
    try {
      if (await steps.registered()) {
        await steps.run();
        return true;
      }
    } catch {
      // not ready yet: try again
    }
    if (i < tries - 1) await steps.sleep(delayMs);
  }
  return false;
}
