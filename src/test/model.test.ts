import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  DEFAULT_DISPATCHED_PATTERN,
  EXAMPLE_DISPATCHED_PATTERN,
  ClassifyContext,
  buildBucket,
  compileDispatchedPattern,
  dispatchedLayout,
  dispatchedScopeKey,
  groupLayout,
  isActive,
  isDispatched,
  machineName,
  moreLabel,
  scopeKey,
  Session,
  TranscriptInfo,
  classify,
  claudeCodeUri,
  clickHint,
  decidePending,
  excludeEmpty,
  findRemote,
  oneLine,
  openHint,
  parsePending,
  pendingMatches,
  remotePath,
  repoRoot,
  resolveConfigDir,
  resumeWithRetry,
  samePending,
  sshFolderUri,
  sameFolder,
  expandHome,
  fallbackSessionUrl,
  firstLine,
  groupSessions,
  iconState,
  isInsideFolders,
  isLocal,
  mirrorFromStatus,
  normPath,
  resolveOpenIn,
  mirrorSessionUrl,
  parseSessions,
  projectKey,
  relativeTime,
  sessionDescription,
  sessionLabel,
  tooltipFields,
  visibleSessions,
} from '../model';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

// Synthetic data only: this repo is public.
function mk(over: Partial<Session> = {}): Session {
  return {
    source: 'claude-code',
    sessionId: 'aaaaaaaa-0000-0000-0000-000000000001',
    machine: 'laptop',
    cwd: '~/projects/app',
    repo: 'github.com/example/app',
    branch: 'main',
    model: 'model-x',
    title: 'Fix the thing',
    firstAsk: 'please fix the thing',
    url: null,
    state: 'idle',
    lastAt: NOW - 5 * MIN,
    lastTool: 'Bash',
    stale: false,
    turns: 3,
    parentId: null,
    ...over,
  };
}

test('parseSessions reads the CLI shape and tolerates nulls', () => {
  const text = JSON.stringify({
    sessions: [
      {
        source: 'claude-code',
        session_id: 'id-1',
        machine: 'laptop',
        cwd: '~/projects/app',
        repo: 'github.com/example/app',
        branch: 'main',
        model: null,
        title: null,
        first_ask: 'hello',
        url: 'https://example.invalid/s/1',
        state: 'working',
        last_at: 5,
        last_tool: null,
        stale: false,
        active_tools: null,
      },
      { session_id: 'id-2', state: 'mystery', parent_id: 'id-1' },
      { title: 'no id' },
      null,
    ],
    now: 99,
    next_offset: null,
    coverage: {},
  });
  const { sessions, now } = parseSessions(text);
  assert.equal(now, 99);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].sessionId, 'id-1');
  assert.equal(sessions[0].firstAsk, 'hello');
  assert.equal(sessions[0].state, 'working');
  assert.equal(sessions[0].model, null);
  assert.equal(sessions[1].state, 'idle', 'unknown state is idle');
  assert.equal(sessions[1].lastAt, 0);
  assert.equal(sessions[1].stale, false);
  assert.equal(sessions[0].parentId, null);
  assert.equal(sessions[1].parentId, 'id-1', 'sessionpipe parent_id');
});

test('parseSessions rejects bad JSON and a missing list', () => {
  assert.throws(() => parseSessions('not json'), /did not return JSON/);
  assert.throws(() => parseSessions('{"now":1}'), /no "sessions"/);
  assert.throws(() => parseSessions('null'), /no "sessions"/);
});

test('projectKey: repo last segment, .git stripped', () => {
  assert.equal(projectKey({ repo: 'github.com/acme/app.git', cwd: null }), 'app');
  assert.equal(projectKey({ repo: 'github.com/acme/app', cwd: '/x/other' }), 'app');
  assert.equal(projectKey({ repo: 'github.com/acme/app/', cwd: null }), 'app');
});

test('projectKey: cwd with worktree suffix stripped, merges with the repo group', () => {
  assert.equal(projectKey({ repo: null, cwd: '~/projects/app/.claude/worktrees/x' }), 'app');
  assert.equal(projectKey({ repo: null, cwd: '~/projects/app/.claude/worktrees/x/sub' }), 'app');
  assert.equal(projectKey({ repo: null, cwd: '~/projects/app' }), 'app');
  assert.equal(projectKey({ repo: null, cwd: '~/projects/app/' }), 'app');
});

test('projectKey: falls back to other', () => {
  assert.equal(projectKey({ repo: null, cwd: null }), 'other');
  assert.equal(projectKey({ repo: null, cwd: '/' }), 'other');
});

test('groups sort by newest last_at, descending', () => {
  const groups = groupSessions(
    [
      mk({ sessionId: 'a', repo: 'github.com/example/old', lastAt: NOW - 3 * HOUR }),
      mk({ sessionId: 'b', repo: 'github.com/example/new', lastAt: NOW - MIN }),
      mk({ sessionId: 'c', repo: 'github.com/example/old', lastAt: NOW - 2 * HOUR }),
    ],
    { now: NOW, hideDoneAfterHours: 24 },
  );
  assert.deepEqual(groups.map((g) => g.key), ['new', 'old']);
});

test('a repo-less worktree row merges with its repo group', () => {
  const groups = groupSessions(
    [mk({ sessionId: 'a' }), mk({ sessionId: 'b', repo: null, cwd: '~/projects/app/.claude/worktrees/x' })],
    { now: NOW, hideDoneAfterHours: 24 },
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].sessions.length, 2);
});

test('inside a group: needs_you, working, idle, done, then newest first', () => {
  const groups = groupSessions(
    [
      mk({ sessionId: 'done', state: 'done', lastAt: NOW - MIN }),
      mk({ sessionId: 'idle-old', state: 'idle', lastAt: NOW - 2 * HOUR }),
      mk({ sessionId: 'idle-new', state: 'idle', lastAt: NOW - HOUR }),
      mk({ sessionId: 'work', state: 'working', lastAt: NOW - 3 * HOUR }),
      mk({ sessionId: 'need', state: 'needs_you', lastAt: NOW - 4 * HOUR }),
    ],
    { now: NOW, hideDoneAfterHours: 24 },
  );
  assert.deepEqual(groups[0].sessions.map((s) => s.sessionId), ['need', 'work', 'idle-new', 'idle-old', 'done']);
});

test('a group with no active session starts collapsed, one with a working session expanded', () => {
  const groups = groupSessions(
    [
      mk({ sessionId: 'a', repo: 'github.com/example/finished', state: 'done' }),
      mk({ sessionId: 'b', repo: 'github.com/example/busy', state: 'done' }),
      mk({ sessionId: 'c', repo: 'github.com/example/busy', state: 'working' }),
    ],
    { now: NOW, hideDoneAfterHours: 24 },
  );
  const by = Object.fromEntries(groups.map((g) => [g.key, g]));
  assert.equal(by.finished.collapsed, true);
  assert.equal(by.busy.collapsed, false);
});

test('group description counts the non-done states', () => {
  const groups = groupSessions(
    [
      mk({ sessionId: 'a', state: 'needs_you' }),
      mk({ sessionId: 'b', state: 'working' }),
      mk({ sessionId: 'c', state: 'working' }),
      mk({ sessionId: 'd', state: 'done' }),
    ],
    { now: NOW, hideDoneAfterHours: 24 },
  );
  assert.equal(groups[0].description, '1 needs you · 2 working');
});

test('done sessions older than the limit are hidden; 0 shows all', () => {
  const list = [
    mk({ sessionId: 'fresh', state: 'done', lastAt: NOW - HOUR }),
    mk({ sessionId: 'stale-done', state: 'done', lastAt: NOW - 30 * HOUR }),
    mk({ sessionId: 'old-idle', state: 'idle', lastAt: NOW - 90 * HOUR }),
  ];
  assert.deepEqual(
    visibleSessions(list, { now: NOW, hideDoneAfterHours: 24 }).map((s) => s.sessionId),
    ['fresh', 'old-idle'],
  );
  assert.equal(visibleSessions(list, { now: NOW, hideDoneAfterHours: 0 }).length, 3);
});

test('a group whose sessions are all hidden disappears', () => {
  const groups = groupSessions([mk({ state: 'done', lastAt: NOW - 100 * HOUR })], { now: NOW, hideDoneAfterHours: 24 });
  assert.equal(groups.length, 0);
});

test('label: title, else first 60 chars of first_ask, else 8 chars of id', () => {
  assert.equal(sessionLabel(mk({ title: 'T' })), 'T');
  assert.equal(sessionLabel(mk({ title: null, firstAsk: 'x'.repeat(80) })), 'x'.repeat(60));
  assert.equal(sessionLabel(mk({ title: null, firstAsk: null, sessionId: '12345678-abcd' })), '12345678');
});

test('relative time', () => {
  assert.equal(relativeTime(NOW - 10_000, NOW), 'now');
  assert.equal(relativeTime(NOW - 3 * MIN, NOW), '3m');
  assert.equal(relativeTime(NOW - 59 * MIN, NOW), '59m');
  assert.equal(relativeTime(NOW - 2 * HOUR, NOW), '2h');
  assert.equal(relativeTime(NOW - 23 * HOUR, NOW), '23h');
  assert.equal(relativeTime(NOW - 30 * HOUR, NOW), 'yesterday');
  assert.equal(relativeTime(NOW - 72 * HOUR, NOW), '3d');
  assert.equal(relativeTime(NOW + HOUR, NOW), 'now', 'a clock skew never goes negative');
});

test('description adds the machine only for a remote session', () => {
  const s = mk({ machine: 'desktop', lastAt: NOW - 3 * MIN });
  assert.equal(sessionDescription(s, NOW, true), '3m');
  assert.equal(sessionDescription(s, NOW, false), '3m ⇄ desktop');
});

test('isLocal: host name, .local suffix, case, localMachines', () => {
  assert.equal(isLocal('laptop', 'laptop.local', []), true);
  assert.equal(isLocal('Laptop.local', 'LAPTOP', []), true);
  assert.equal(isLocal('desktop', 'laptop', []), false);
  assert.equal(isLocal('desktop', 'laptop', ['Desktop']), true);
  assert.equal(isLocal('desktop', 'laptop', ['desktop.local']), true);
  assert.equal(isLocal(null, 'laptop', []), true);
});

test('a stale session shows the idle icon whatever its state', () => {
  assert.equal(iconState({ state: 'working', stale: true }), 'idle');
  assert.equal(iconState({ state: 'needs_you', stale: true }), 'idle');
  assert.equal(iconState({ state: 'working', stale: false }), 'working');
});

test('expandHome and isInsideFolders', () => {
  assert.equal(expandHome('~/projects/app', '/home/u'), '/home/u/projects/app');
  assert.equal(expandHome('~', '/home/u/'), '/home/u/');
  assert.equal(expandHome('/abs/path', '/home/u'), '/abs/path');
  const folders = ['/home/u/projects/app'];
  assert.equal(isInsideFolders('~/projects/app', folders, '/home/u'), true);
  assert.equal(isInsideFolders('~/projects/app/.claude/worktrees/x', folders, '/home/u'), true);
  assert.equal(isInsideFolders('~/projects/app-two', folders, '/home/u'), false, 'a shared prefix is not inside');
  assert.equal(isInsideFolders('~/projects/other', folders, '/home/u'), false);
  assert.equal(isInsideFolders('~/projects/other', [], '/home/u'), false);
});

test('mirror URL: base, path, placeholders URL-encoded', () => {
  const s = { source: 'claude-code', sessionId: 'a/b c', machine: 'my desktop' };
  assert.equal(
    mirrorSessionUrl(s, { mirrorUrl: 'http://localhost:4280/', remoteSessionPath: '/sessions' }),
    'http://localhost:4280/sessions',
  );
  assert.equal(
    mirrorSessionUrl(s, { mirrorUrl: 'http://localhost:4280', remoteSessionPath: '/sessions/{source}/{id}' }),
    'http://localhost:4280/sessions/claude-code/a%2Fb%20c',
  );
  assert.equal(
    mirrorSessionUrl(s, { mirrorUrl: 'http://localhost:4280', remoteSessionPath: 'm/{machine}/{source}/{id}' }),
    'http://localhost:4280/m/my%20desktop/claude-code/a%2Fb%20c',
  );
});

test('fallback URL uses spacesheep.dev and the same path', () => {
  const s = { source: 'claude-code', sessionId: 'abc', machine: 'desktop' };
  assert.equal(
    fallbackSessionUrl(s, { mirrorUrl: 'http://localhost:4280', remoteSessionPath: '/s/{id}' }),
    'https://spacesheep.dev/s/abc',
  );
});

test('Claude Code URI', () => {
  assert.equal(claudeCodeUri('vscode', 'abc'), 'vscode://anthropic.claude-code/open?session=abc');
  assert.equal(claudeCodeUri('vscode-insiders', 'a b'), 'vscode-insiders://anthropic.claude-code/open?session=a%20b');
});

test('firstLine skips blanks', () => {
  assert.equal(firstLine('\n  \nnot signed in\nmore'), 'not signed in');
  assert.equal(firstLine(''), '');
});

test('tooltip fields omit nulls and flag stale', () => {
  const fields = tooltipFields(mk({ model: null, branch: null, stale: true, state: 'working' }));
  assert.deepEqual(fields.map((f) => f[0]), ['State', 'Machine', 'Folder', 'Last tool']);
  assert.equal(fields[0][1], 'working (stale)');
});

// ---- v0.2: openability ------------------------------------------------------------------------

const HOME = '/home/user';
const WITH_MSG: TranscriptInfo = { found: true, hasUser: true, firstUser: 'hello there' };

function ctx(over: Partial<ClassifyContext> = {}): ClassifyContext {
  return {
    local: true,
    folders: [`${HOME}/projects/app`],
    home: HOME,
    transcript: () => WITH_MSG,
    dirExists: () => true,
    ...over,
  };
}

test('classify: here when the cwd is a workspace folder, inside one, or a worktree of one', () => {
  assert.equal(classify(mk({ cwd: '~/projects/app' }), ctx()).kind, 'here');
  assert.equal(classify(mk({ cwd: '~/projects/app/src' }), ctx()).kind, 'here');
  assert.equal(classify(mk({ cwd: '~/projects/app/.claude/worktrees/v1' }), ctx()).kind, 'here');
  assert.equal(classify(mk({ cwd: `${HOME}/projects/app` }), ctx()).kind, 'here');
  assert.equal(classify(mk({ cwd: null }), ctx()).kind, 'here');
});

test('classify: otherFolder when the cwd is outside every workspace folder', () => {
  const c = classify(mk({ cwd: '~/projects/other' }), ctx());
  assert.equal(c.kind, 'otherFolder');
  assert.equal(c.cwdGone, false);
  assert.equal(c.folder, `${HOME}/projects/other`);
  assert.equal(c.firstUser, 'hello there');
  assert.equal(classify(mk({ cwd: '~/projects/app-two' }), ctx()).kind, 'otherFolder'); // prefix is not inside
});

test('classify: a removed worktree falls back to the repo root, else noTranscript', () => {
  const cwd = '~/projects/other/.claude/worktrees/gone';
  const root = `${HOME}/projects/other`;
  const c = classify(mk({ cwd }), ctx({ dirExists: (p) => p === root }));
  assert.equal(c.kind, 'otherFolder');
  assert.equal(c.cwdGone, true);
  assert.equal(c.folder, root);
  const none = classify(mk({ cwd }), ctx({ dirExists: () => false }));
  assert.equal(none.kind, 'noTranscript');
  assert.equal(none.cwdGone, true);
  // a plain folder that vanished has no root to fall back to
  assert.equal(classify(mk({ cwd: '~/projects/vanished' }), ctx({ dirExists: () => false })).kind, 'noTranscript');
});

test('classify: remote for another machine', () => {
  let asked = false;
  const c = classify(mk({ machine: 'server' }), ctx({ local: false, transcript: () => ((asked = true), WITH_MSG) }));
  assert.equal(c.kind, 'remote');
  assert.equal(asked, false, 'no filesystem lookup for a remote row');
});

test('classify: empty without turns, title or ask, on any machine; or a transcript with no message', () => {
  const blank = { turns: 0, title: null, firstAsk: null };
  assert.equal(classify(mk(blank), ctx()).kind, 'empty');
  assert.equal(classify(mk({ ...blank, machine: 'server' }), ctx({ local: false })).kind, 'empty');
  const noUser: TranscriptInfo = { found: true, hasUser: false, firstUser: null };
  assert.equal(classify(mk(), ctx({ transcript: () => noUser })).kind, 'empty');
  // unknown turns and nothing else, and no transcript: nothing to open either
  assert.equal(
    classify(mk({ turns: null, title: null, firstAsk: null }), ctx({ transcript: () => ({ ...noUser, found: false }) })).kind,
    'empty',
  );
});

test('classify: noTranscript when the row has a name or turns but no transcript here', () => {
  const missing: TranscriptInfo = { found: false, hasUser: false, firstUser: null };
  assert.equal(classify(mk(), ctx({ transcript: () => missing })).kind, 'noTranscript');
  assert.equal(
    classify(mk({ title: null, firstAsk: null, turns: 4 }), ctx({ transcript: () => missing })).kind,
    'noTranscript',
  );
});

test('hints: description and tooltip per outcome', () => {
  const s = mk({ cwd: '~/projects/other', repo: 'github.com/example/other', machine: 'server' });
  const mkc = (kind: 'here' | 'otherFolder' | 'remote' | 'empty' | 'noTranscript') => ({
    kind,
    cwdGone: false,
    folder: null,
    firstUser: null,
    dispatched: false,
  });
  assert.equal(openHint(mkc('here'), s), '');
  assert.equal(openHint(mkc('otherFolder'), s), '↗ other');
  assert.equal(openHint(mkc('remote'), s), '⇄ server');
  assert.equal(openHint(mkc('noTranscript'), s), 'no transcript');
  assert.equal(sessionDescription(s, NOW, true, mkc('otherFolder')), '5m ↗ other');
  assert.equal(sessionDescription(s, NOW, true, mkc('here')), '5m');
  assert.match(clickHint(mkc('remote'), s, true), /over SSH/);
  assert.equal(clickHint(mkc('remote'), s, false), 'Click: show on spacesheep.');
  assert.equal(clickHint(mkc('remote'), s, true, false), 'Click: show on spacesheep.', 'resume off');
  assert.equal(clickHint(mkc('otherFolder'), s, false, false), 'Click: show on spacesheep (the folder is not open here).');
  assert.match(clickHint(mkc('empty'), s, false), /never got a prompt/);
});

// ---- v0.2: labels, hidden rows ----------------------------------------------------------------

test('sessionLabel falls back to the transcript\'s first message, one line, 60 chars', () => {
  const nameless = mk({ title: null, firstAsk: null });
  assert.equal(sessionLabel(nameless, 'first\n   line\tof it'), 'first line of it');
  assert.equal(sessionLabel(nameless, 'x'.repeat(100)), 'x'.repeat(60));
  assert.equal(sessionLabel(nameless, null), 'aaaaaaaa');
  assert.equal(sessionLabel(nameless), 'aaaaaaaa');
  assert.equal(sessionLabel(mk({ title: 'T' }), 'ignored'), 'T');
  assert.equal(oneLine('  a \n b  '), 'a b');
});

test('empty rows are hidden by default; a group of only empty rows disappears; counts ignore them', () => {
  const rows = [
    mk({ sessionId: 'e1', state: 'working', turns: 0, title: null, firstAsk: null }),
    mk({ sessionId: 'e2', state: 'working', turns: 0, title: null, firstAsk: null, cwd: '~/projects/lonely', repo: null }),
    mk({ sessionId: 'n1', state: 'needs_you' }),
  ];
  const classes = new Map(rows.map((r) => [r.sessionId, classify(r, ctx())]));
  const hidden = groupSessions(rows, { now: NOW, hideDoneAfterHours: 24, exclude: excludeEmpty(classes, false) });
  assert.deepEqual(hidden.map((g) => g.key), ['app']);
  assert.deepEqual(hidden[0].sessions.map((s) => s.sessionId), ['n1']);
  assert.equal(hidden[0].description, '1 needs you');
  const shown = groupSessions(rows, { now: NOW, hideDoneAfterHours: 24, exclude: excludeEmpty(classes, true) });
  assert.equal(shown.length, 2);
  assert.equal(shown.find((g) => g.key === 'app')?.description, '1 needs you · 1 working');
});

test('parseSessions reads turns', () => {
  const { sessions } = parseSessions(
    JSON.stringify({ sessions: [{ session_id: 'a', turns: 0 }, { session_id: 'b' }, { session_id: 'c', turns: 7 }] }),
  );
  assert.deepEqual(sessions.map((s) => s.turns), [0, null, 7]);
});

// ---- v0.2: config dir -------------------------------------------------------------------------

test('resolveConfigDir: setting, then Claude Code env entry, then process env, then ~/.claude', () => {
  const env = [{ name: 'OTHER', value: 'x' }, { name: 'CLAUDE_CONFIG_DIR', value: '~/cc-ext' }];
  const base = { home: HOME };
  assert.equal(resolveConfigDir({ ...base, setting: '/s/dir/', claudeCodeEnv: env, processEnv: '/p' }), '/s/dir');
  assert.equal(resolveConfigDir({ ...base, setting: '', claudeCodeEnv: env, processEnv: '/p' }), `${HOME}/cc-ext`);
  assert.equal(resolveConfigDir({ ...base, claudeCodeEnv: [{ name: 'OTHER', value: 'x' }], processEnv: '/p' }), '/p');
  assert.equal(resolveConfigDir({ ...base, claudeCodeEnv: 'junk', processEnv: '' }), `${HOME}/.claude`);
  assert.equal(resolveConfigDir({ ...base }), `${HOME}/.claude`);
  assert.equal(repoRoot('/a/b/.claude/worktrees/x/'), '/a/b');
});

// ---- v0.2: SSH --------------------------------------------------------------------------------

test('findRemote matches a machine name loosely and ignores malformed entries', () => {
  const remotes = {
    Server: { sshHost: 'srv', home: '/home/dev' },
    broken: { sshHost: 'x' },
  };
  assert.deepEqual(findRemote(remotes, 'server.local'), { sshHost: 'srv', home: '/home/dev' });
  assert.equal(findRemote(remotes, 'broken'), null);
  assert.equal(findRemote(remotes, 'laptop'), null);
  assert.equal(findRemote(remotes, null), null);
  assert.equal(findRemote(undefined, 'server'), null);
});

test('sshFolderUri gives the vscode-remote URI\'s parts from home and cwd', () => {
  const host = { sshHost: 'srv', home: '/home/dev/' };
  assert.deepEqual(sshFolderUri(host, '~/projects/app'), {
    scheme: 'vscode-remote',
    authority: 'ssh-remote+srv',
    path: '/home/dev/projects/app',
  });
  assert.equal(sshFolderUri(host, '/srv/data').path, '/srv/data');
  assert.equal(sshFolderUri(host, '~').path, '/home/dev');
  assert.equal(sshFolderUri(host, null).path, '/home/dev');
  assert.equal(remotePath('/home/dev', 'rel/x'), '/home/dev/rel/x');
  // a removed worktree cannot be known remotely: the cwd is used as is
  assert.equal(sshFolderUri(host, '~/p/.claude/worktrees/x').path, '/home/dev/p/.claude/worktrees/x');
});

test('sshFolderUri keeps #, ? and % in the path, for Uri.from to encode', () => {
  // Built as one string, `#b` would become a fragment, `?c` a query and `%41` an `A` under
  // Uri.parse; as parts, the path is the folder's own name.
  const host = { sshHost: 'user@srv', home: '/home/dev' };
  const parts = sshFolderUri(host, '~/a#b/c?d/e%41 f');
  assert.equal(parts.path, '/home/dev/a#b/c?d/e%41 f');
  assert.equal(parts.authority, 'ssh-remote+user@srv');
  // an authority needs a path from the root (Uri.from throws otherwise)
  assert.equal(sshFolderUri({ sshHost: 'srv', home: 'home/dev' }, '~/x').path, '/home/dev/x');
});

test('classify hands the transcript lookup the session\'s cwd, home expanded', () => {
  const seen: Array<[string, string | null]> = [];
  const look = (id: string, cwd: string | null) => (seen.push([id, cwd]), WITH_MSG);
  classify(mk({ sessionId: 's1', cwd: '~/projects/app' }), ctx({ transcript: look }));
  classify(mk({ sessionId: 's2', cwd: null }), ctx({ transcript: look }));
  assert.deepEqual(seen, [
    ['s1', '/home/user/projects/app'],
    ['s2', null],
  ]);
});

// ---- v0.2: pending open -----------------------------------------------------------------------

test('pendingMatches: age under two minutes and a folder of this window', () => {
  const p = { sessionId: 'id', folder: '/home/user/projects/other', at: NOW };
  assert.equal(pendingMatches(p, NOW + 119_000, ['/x', '/home/user/projects/other']), true);
  assert.equal(pendingMatches(p, NOW + 120_000, ['/home/user/projects/other']), false);
  assert.equal(pendingMatches(p, NOW - 1, ['/home/user/projects/other']), false);
  assert.equal(pendingMatches(p, NOW, ['/home/user/projects/app']), false);
  assert.equal(pendingMatches(p, NOW, ['/home/user/projects/other/']), true);
  assert.equal(pendingMatches({ ...p, folder: '/' }, NOW, ['/']), true);
});

test('samePending: same session, moment and folder only', () => {
  const p = { sessionId: 'id', folder: '/w', at: NOW };
  assert.equal(samePending({ ...p }, p), true);
  assert.equal(samePending({ ...p, at: NOW + 1 }, p), false, 'a newer click for the same session');
  assert.equal(samePending({ ...p, sessionId: 'other' }, p), false);
  assert.equal(samePending(undefined, p), false);
  assert.equal(samePending(null, p), false);
});

// A scripted Claude Code: which calls `resumeWithRetry` makes, in order.
function steps(o: { activate?: () => Promise<unknown>; registeredAfter?: number; runFails?: number }) {
  const calls: string[] = [];
  let polls = 0;
  let runs = 0;
  return {
    calls,
    steps: {
      activate: async () => {
        calls.push('activate');
        return o.activate?.();
      },
      registered: async () => {
        calls.push('registered');
        return ++polls > (o.registeredAfter ?? 0);
      },
      run: async () => {
        calls.push('run');
        if (++runs <= (o.runFails ?? 0)) throw new Error('not ready');
      },
      sleep: async () => {
        calls.push('sleep');
      },
    },
  };
}

test('resumeWithRetry activates Claude Code first, then runs its command once registered', async () => {
  const a = steps({ registeredAfter: 2 });
  assert.equal(await resumeWithRetry(a.steps), true);
  assert.deepEqual(a.calls, ['activate', 'registered', 'sleep', 'registered', 'sleep', 'registered', 'run']);
  // a command that throws while the extension settles is retried
  const b = steps({ runFails: 1 });
  assert.equal(await resumeWithRetry(b.steps), true);
  assert.deepEqual(b.calls, ['activate', 'registered', 'run', 'sleep', 'registered', 'run']);
});

test('resumeWithRetry: a failed activation still polls, and gives up with false, never a throw', async () => {
  const a = steps({ activate: () => Promise.reject(new Error('no such extension')), registeredAfter: 1 });
  assert.equal(await resumeWithRetry(a.steps), true);
  const never = steps({ registeredAfter: 99 });
  assert.equal(await resumeWithRetry(never.steps, 3), false);
  assert.deepEqual(never.calls, ['activate', 'registered', 'sleep', 'registered', 'sleep', 'registered']);
});

test('parsePending rejects malformed values', () => {
  assert.equal(parsePending(null), null);
  assert.equal(parsePending({ sessionId: 'a', folder: '/f' }), null);
  assert.deepEqual(parsePending({ sessionId: 'a', folder: '/f', at: 1, extra: 1 }), { sessionId: 'a', folder: '/f', at: 1 });
});

test('decidePending: fires with a failing CLI, because it never looks at the CLI', () => {
  // The CLI is missing on this host: a refresh would throw. The decision has no input from it.
  assert.throws(() => parseSessions('spacesheep: command not found'));
  const stored = { sessionId: 'id', folder: '/srv/work/app', at: NOW };
  const d = decidePending(stored, NOW + 5_000, ['/srv/work/app']);
  assert.deepEqual(d, { run: stored, clear: false }); // removed only once the session opened
});

test('decidePending: a taken hand-over is left to its window; any folder case matches', () => {
  const stored = { sessionId: 'id', folder: 'C:\\Work\\App', at: NOW };
  assert.equal(decidePending(stored, NOW + 1000, ['c:\\work\\app'])?.run?.sessionId, 'id');
  assert.equal(decidePending(stored, NOW + 1000, ['/c:/work/app/'])?.run, null, 'a URI path is not an fsPath');
  const taken = { ...stored, takenAt: NOW + 1000 };
  assert.deepEqual(decidePending(taken, NOW + 2000, ['c:\\work\\app']), { run: null, clear: false });
  // a window that took it and went quiet frees it after the hold
  assert.equal(decidePending(taken, NOW + 1000 + 46_000, ['c:\\work\\app'])?.run?.sessionId, 'id');
  assert.deepEqual(parsePending(taken), taken);
});

test('sameFolder: a drive letter of either case, a trailing slash, the host without case', () => {
  const f = (path: string, authority = '') => ({ scheme: 'file', authority, path });
  assert.equal(sameFolder(f('/C:/work/app'), f('/c:/work/app/')), true);
  assert.equal(sameFolder(f('/srv/App'), f('/srv/app')), false);
  assert.equal(sameFolder(f('/work/App'), f('/work/app'), true), true);
  assert.equal(sameFolder(f('/srv/app', 'ssh-remote+Box'), f('/srv/app', 'ssh-remote+box')), true);
  assert.equal(sameFolder(f('/srv/app'), { scheme: 'vscode-remote', authority: '', path: '/srv/app' }), false);
});

test('decidePending: other windows leave it, stale and malformed values are cleared', () => {
  const stored = { sessionId: 'id', folder: '/srv/work/app', at: NOW };
  assert.deepEqual(decidePending(stored, NOW + 1000, ['/elsewhere']), { run: null, clear: false });
  assert.deepEqual(decidePending(stored, NOW + 200_000, ['/srv/work/app']), { run: null, clear: true });
  assert.deepEqual(decidePending({ junk: true }, NOW, ['/srv/work/app']), { run: null, clear: true });
  assert.deepEqual(decidePending(undefined, NOW, ['/srv/work/app']), { run: null, clear: false });
});

test('classify: a removed cwd inside an open folder is not `here` (Claude Code opens it blank)', () => {
  const wt = '~/projects/app/.claude/worktrees/gone';
  const c = classify(mk({ cwd: wt }), ctx({ dirExists: () => false }));
  assert.equal(c.kind, 'noTranscript');
  assert.equal(c.cwdGone, true);
  assert.equal(openHint(c, mk({ cwd: wt })), 'worktree removed');
  assert.match(clickHint(c, mk({ cwd: wt }), false), /worktree was removed/);
  const plain = mk({ cwd: '~/projects/app/sub' });
  assert.equal(openHint(classify(plain, ctx({ dirExists: () => false })), plain), 'folder removed');
  // the workspace folder itself counts as existing, and an existing worktree is still `here`
  assert.equal(classify(mk({ cwd: '~/projects/app' }), ctx({ dirExists: () => false })).kind, 'here');
  assert.equal(classify(mk({ cwd: wt }), ctx({ dirExists: () => true })).kind, 'here');
  // a gone cwd outside every open folder keeps the repo-root fallback; with no root it reads "removed"
  const out = mk({ cwd: '~/projects/other/.claude/worktrees/w' });
  assert.equal(openHint(classify(out, ctx({ dirExists: () => false })), out), 'worktree removed');
});

// ---- v0.3: hosts, dispatched, active first ----------------------------------------------------

test('machineName and the host in the description', () => {
  assert.equal(machineName('Laptop.local'), 'Laptop');
  assert.equal(machineName('server'), 'server');
  const s = mk();
  assert.equal(sessionDescription(s, NOW, true, undefined, 'laptop'), '5m @laptop');
  assert.equal(sessionDescription(s, NOW, true, undefined, null), '5m');
  const here = { kind: 'otherFolder' as const, cwdGone: false, folder: null, firstUser: null, dispatched: false };
  assert.equal(sessionDescription(mk({ cwd: '~/x/other', repo: null }), NOW, true, here, 'laptop'), '5m ↗ other @laptop');
  // a remote row's hint already names the machine
  const remote = { ...here, kind: 'remote' as const };
  assert.equal(sessionDescription(mk({ machine: 'server' }), NOW, false, remote, 'server'), '5m ⇄ server');
  assert.deepEqual(tooltipFields(mk({ machine: null }), 'laptop').find((f) => f[0] === 'Machine'), ['Machine', 'laptop']);
});

test('isDispatched: sdk-cli entrypoint or a title matching the pattern', () => {
  assert.equal(compileDispatchedPattern(DEFAULT_DISPATCHED_PATTERN), null, 'off by default');
  const pat = compileDispatchedPattern(EXAMPLE_DISPATCHED_PATTERN);
  assert.ok(pat);
  assert.equal(isDispatched('sdk-cli', 'plain title', pat), true);
  assert.equal(isDispatched('cli', 'plain title', pat), false);
  assert.equal(isDispatched(null, 'app: add retries · server', pat), true);
  assert.equal(isDispatched(null, 'a · b c', pat), false); // the host is one word
  assert.equal(isDispatched(null, 'no separator', pat), false);
  assert.equal(isDispatched(null, null, pat), false);
  assert.equal(isDispatched(null, 'app · server', null), false);
  assert.equal(compileDispatchedPattern('('), null);
  assert.equal(compileDispatchedPattern(''), null);
});

test('classify marks dispatched rows: transcript entrypoint locally, title only for remote rows', () => {
  const dispatchedPattern = compileDispatchedPattern(EXAMPLE_DISPATCHED_PATTERN);
  const sdk: TranscriptInfo = { ...WITH_MSG, entrypoint: 'sdk-cli' };
  assert.equal(classify(mk(), ctx({ transcript: () => sdk, dispatchedPattern })).dispatched, true);
  assert.equal(classify(mk(), ctx({ transcript: () => ({ ...WITH_MSG, entrypoint: 'cli' }), dispatchedPattern })).dispatched, false);
  assert.equal(classify(mk({ title: 'app: job · box' }), ctx({ dispatchedPattern })).dispatched, true);
  // a remote row: the entrypoint cannot be read, so only the title decides
  const remote = ctx({ local: false, transcript: () => sdk, dispatchedPattern });
  assert.equal(classify(mk({ machine: 'server' }), remote).dispatched, false);
  assert.equal(classify(mk({ machine: 'server', title: 'app: job · box' }), remote).dispatched, true);
});

test("Windows paths: backslashes and the drive letter's case do not change what is inside what", () => {
  const home = 'C:\\Users\\me';
  assert.equal(normPath('C:\\Users\\me\\app\\'), 'c:/users/me/app');
  assert.equal(normPath('/home/me/App/'), '/home/me/App', 'POSIX paths keep their case');
  assert.equal(normPath('/'), '/');
  assert.equal(isInsideFolders('C:\\Users\\me\\app\\.claude\\worktrees\\fix', ['c:\\Users\\me\\app'], home), true);
  assert.equal(isInsideFolders('~\\app\\sub', ['c:\\users\\me\\app'], home), true);
  assert.equal(isInsideFolders('C:\\Users\\me\\apple', ['c:\\Users\\me\\app'], home), false);
  assert.equal(projectKey({ repo: null, cwd: 'C:\\Users\\me\\projects\\app\\.claude\\worktrees\\fix' }), 'app');
  assert.equal(repoRoot('C:\\Users\\me\\app\\.claude\\worktrees\\fix\\src'), 'C:\\Users\\me\\app', 'its own case: a folder to open');
  const s = mk({ cwd: 'C:\\Users\\me\\app\\.claude\\worktrees\\fix' });
  const c = classify(s, ctx({ home, folders: ['c:\\Users\\me\\app'], dirExists: () => true }));
  assert.equal(c.kind, 'here');
  assert.equal(c.folder, 'C:\\Users\\me\\app\\.claude\\worktrees\\fix', 'opened in its own case');
});

test('machine names: the CLI trims .local, .lan and .home, and may report a name of its own', () => {
  assert.equal(machineName('box.lan'), 'box');
  assert.equal(machineName('box.home'), 'box');
  assert.equal(machineName('Box.local'), 'Box');
  assert.equal(machineName('box.lan', 'studio'), 'studio');
  assert.equal(isLocal('box', 'box.lan', []), true);
  assert.equal(isLocal('studio', 'box.lan', [], 'studio'), true);
  assert.equal(isLocal('studio', 'box.lan', [], null), false);
});

test('mirrorFromStatus: a running mirror of this site, at the port it reports', () => {
  const site = 'https://site.example';
  assert.equal(mirrorFromStatus('{"pid":1,"port":4281,"site":"https://site.example"}', site), 'http://localhost:4281');
  assert.equal(mirrorFromStatus('{"pid":1,"port":4281,"site":"https://site.example/"}', site), 'http://localhost:4281');
  assert.equal(mirrorFromStatus('{"running":false}', site), null);
  assert.equal(mirrorFromStatus('{"pid":1,"port":4281,"site":"http://localhost:8787"}', site), null, 'a mirror of a dev server');
  assert.equal(mirrorFromStatus('{"pid":1,"site":"https://site.example"}', site), null, 'no port');
  assert.equal(mirrorFromStatus('{"pid":1,"port":"4281","site":"https://site.example"}', site), null);
  assert.equal(mirrorFromStatus('Unknown command: mirror', site), null, 'a CLI before 1.27');
  assert.equal(mirrorFromStatus('null', site), null);
});

test('resolveOpenIn: openIn wins once set; the deprecated remoteOpenIn external only while it is unset', () => {
  assert.equal(resolveOpenIn({ explicit: undefined, effective: 'editor' }, undefined), 'editor');
  assert.equal(resolveOpenIn({ explicit: undefined, effective: 'editor' }, 'external'), 'browser');
  assert.equal(resolveOpenIn({ explicit: 'editor', effective: 'editor' }, 'external'), 'editor');
  assert.equal(resolveOpenIn({ explicit: 'browser', effective: 'browser' }, 'simpleBrowser'), 'browser');
  assert.equal(resolveOpenIn({ explicit: 'nonsense', effective: 'nonsense' }, undefined), 'editor');
});

test('isActive respects stale', () => {
  assert.equal(isActive(mk({ state: 'working' })), true);
  assert.equal(isActive(mk({ state: 'needs_you' })), true);
  assert.equal(isActive(mk({ state: 'working', stale: true })), false);
  assert.equal(isActive(mk({ state: 'idle' })), false);
});

const ids = (l: Session[]) => l.map((s) => s.sessionId);

test('buildBucket: all active rows, capped inactive rows (idle before done), "N more…"', () => {
  const rows = [
    mk({ sessionId: 'w1', state: 'working', lastAt: NOW - 9 * MIN }),
    mk({ sessionId: 'n1', state: 'needs_you', lastAt: NOW - 20 * MIN }),
    mk({ sessionId: 'i1', state: 'idle', lastAt: NOW - 30 * MIN }),
    mk({ sessionId: 'd1', state: 'done', lastAt: NOW - 1 * MIN }),
    mk({ sessionId: 'i2', state: 'idle', lastAt: NOW - 40 * MIN }),
    mk({ sessionId: 'i3', state: 'idle', lastAt: NOW - 50 * MIN }),
    mk({ sessionId: 's1', state: 'working', stale: true, lastAt: NOW - 60 * MIN }),
  ];
  const b = buildBucket(rows, 3);
  assert.deepEqual(ids(b.active), ['n1', 'w1']);
  assert.deepEqual(ids(b.inactive), ['i1', 'i2', 'i3'], 'stale counts as idle; idle before done');
  assert.equal(b.hidden, 2);
  assert.deepEqual(b.more, { kind: 'more', count: 2 });
  assert.equal(moreLabel(b.more!), '2 more in the fold…');
  // lifted: everything shows, with a way back; showAll: everything shows, no row
  const lifted = buildBucket(rows, 3, { lifted: true });
  assert.equal(lifted.inactive.length, 5);
  assert.deepEqual(lifted.more, { kind: 'fewer' });
  assert.equal(moreLabel(lifted.more!), 'show fewer');
  assert.equal(buildBucket(rows, 3, { showAll: true }).more, null);
  assert.equal(buildBucket(rows, 3, { showAll: true, lifted: true }).more, null);
  // cap 0 shows no inactive row; at or under the cap there is no row at all
  assert.equal(buildBucket(rows, 0).inactive.length, 0);
  assert.deepEqual(buildBucket(rows, 0).more, { kind: 'more', count: 5 });
  assert.equal(buildBucket(rows, 5).more, null);
  assert.equal(buildBucket(rows, 5, { lifted: true }).more, null, 'nothing to fold back');
});

test('groups: those with active rows first (most active, then newest), then the rest', () => {
  const g = (repo: string, rows: Array<Partial<Session>>) =>
    rows.map((r, i) => mk({ sessionId: `${repo}${i}`, repo: `github.com/example/${repo}`, ...r }));
  const sessions = [
    ...g('quiet-new', [{ state: 'idle', lastAt: NOW - MIN }]),
    ...g('one', [{ state: 'working', lastAt: NOW - 50 * MIN }]),
    ...g('two', [{ state: 'working', lastAt: NOW - 60 * MIN }, { state: 'needs_you', lastAt: NOW - 70 * MIN }]),
    ...g('stale-only', [{ state: 'working', stale: true, lastAt: NOW - 2 * MIN }]),
    ...g('one-newer', [{ state: 'working', lastAt: NOW - 5 * MIN }]),
  ];
  const groups = groupSessions(sessions, { now: NOW, hideDoneAfterHours: 24 });
  assert.deepEqual(groups.map((x) => x.key), ['two', 'one-newer', 'one', 'quiet-new', 'stale-only']);
  assert.deepEqual(groups.map((x) => x.collapsed), [false, false, false, true, true]);
});

test('dispatched rows nest in one node: after the active rows, before the inactive ones', () => {
  const rows = [
    mk({ sessionId: 'a-active', state: 'working' }),
    mk({ sessionId: 'a-idle', state: 'idle' }),
    mk({ sessionId: 'd-idle', state: 'idle', title: 'x · box' }),
    mk({ sessionId: 'd-done', state: 'done', title: 'y · box' }),
  ];
  const isD = (s: Session) => s.sessionId.startsWith('d-');
  const [g] = groupSessions(rows, { now: NOW, hideDoneAfterHours: 24, isDispatched: isD });
  const top = groupLayout(g);
  assert.deepEqual(top.map((i) => (i.kind === 'session' ? i.session.sessionId : i.kind)), ['a-active', 'dispatched', 'a-idle']);
  assert.deepEqual(top[1], { kind: 'dispatched', count: 2, expanded: false });
  assert.deepEqual(dispatchedLayout(g).map((i) => (i.kind === 'session' ? i.session.sessionId : i.kind)), ['d-idle', 'd-done']);
  // active dispatched rows expand the node
  const [g2] = groupSessions([...rows, mk({ sessionId: 'd-live', state: 'needs_you', title: 'z · box' })], {
    now: NOW,
    hideDoneAfterHours: 24,
    isDispatched: isD,
  });
  assert.equal(g2.dispatchedExpanded, true);
  assert.equal(g2.activeCount, 2);
  assert.equal(g2.dispatched?.active[0].sessionId, 'd-live');
  // no dispatched rows: no node
  assert.equal(groupSessions(rows.slice(0, 2), { now: NOW, hideDoneAfterHours: 24 })[0].dispatched, null);
});

test('caps are per group and per node; the lift is per scope; the global toggle overrides', () => {
  const rows = [
    ...[1, 2, 3].map((n) => mk({ sessionId: `i${n}`, state: 'idle', lastAt: NOW - n * MIN })),
    ...[1, 2, 3].map((n) => mk({ sessionId: `d${n}`, state: 'idle', lastAt: NOW - n * MIN, title: 't · h' })),
  ];
  const isD = (s: Session) => s.sessionId.startsWith('d');
  const base = { now: NOW, hideDoneAfterHours: 24, inactivePerGroup: 2, isDispatched: isD };
  const [g] = groupSessions(rows, base);
  assert.deepEqual(g.interactive.more, { kind: 'more', count: 1 });
  assert.deepEqual(g.dispatched?.more, { kind: 'more', count: 1 });
  assert.equal(groupLayout(g).at(-1)?.kind, 'more');
  const [lift] = groupSessions(rows, { ...base, expanded: new Set([dispatchedScopeKey('app')]) });
  assert.deepEqual(lift.interactive.more, { kind: 'more', count: 1 });
  assert.deepEqual(lift.dispatched?.more, { kind: 'fewer' });
  const [lift2] = groupSessions(rows, { ...base, expanded: new Set([scopeKey('app')]) });
  assert.deepEqual(lift2.interactive.more, { kind: 'fewer' });
  const [all] = groupSessions(rows, { ...base, showAllInactive: true });
  assert.equal(all.interactive.more, null);
  assert.equal(all.dispatched?.inactive.length, 3);
  // the flat list and the description still count every visible row
  assert.equal(g.sessions.length, 6);
});
