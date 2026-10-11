import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Session,
  badgeTooltip,
  childLayout,
  groupLayout,
  groupSessions,
  nestChildren,
  nudgeFor,
  nudgeText,
  quietLine,
  refreshDelaySeconds,
  rootOf,
  stateMap,
  tally,
} from '../model';
import { ChildLinks, childLinksDir, parseChildLink } from '../local';

// Synthetic data only: this repo is public.
const NOW = 1_800_000_000_000;
const MIN = 60_000;

function mk(id: string, over: Partial<Session> = {}): Session {
  return {
    source: 'claude-code',
    sessionId: id,
    machine: 'laptop',
    cwd: '~/projects/app',
    repo: 'github.com/example/app',
    branch: 'main',
    model: 'model-x',
    title: `session ${id}`,
    firstAsk: null,
    url: null,
    state: 'idle',
    lastAt: NOW - 5 * MIN,
    lastTool: null,
    stale: false,
    turns: 3,
    parentId: null,
    ...over,
  };
}

const links = (pairs: Record<string, string>) => (s: Session) => pairs[s.sessionId] ?? null;
const ids = (rows: { kind: string; session?: Session }[]) => rows.map((r) => (r.kind === 'session' ? r.session!.sessionId : r.kind));

test('rootOf: a chain flattens to its topmost visible ancestor; a hidden parent or a cycle stops', () => {
  const a = mk('a');
  const b = mk('b');
  const c = mk('c');
  const byId = new Map([a, b, c].map((s) => [s.sessionId, s]));
  assert.equal(rootOf(c, byId, links({ c: 'b', b: 'a' })).sessionId, 'a');
  assert.equal(rootOf(c, byId, links({ c: 'b', b: 'gone' })).sessionId, 'b');
  assert.equal(rootOf(c, byId, links({ c: 'gone' })).sessionId, 'c');
  assert.equal(rootOf(a, byId, links({ a: 'b', b: 'a' })).sessionId, 'b', 'a cycle ends at the last new row');
  assert.equal(rootOf(a, byId, links({ a: 'a' })).sessionId, 'a');
});

test('nestChildren: children sorted active first, keyed by their root', () => {
  const rows = [mk('p'), mk('k1', { state: 'done' }), mk('k2', { state: 'working' }), mk('k3', { state: 'idle' })];
  const kids = nestChildren(rows, links({ k1: 'p', k2: 'k1', k3: 'p' }));
  assert.deepEqual([...kids.keys()], ['p']);
  assert.deepEqual(kids.get('p')!.map((s) => s.sessionId), ['k2', 'k3', 'k1']);
  assert.equal(nestChildren(rows).size, 0, 'no links: nothing nested');
});

test('groupSessions: a child leaves the buckets and nests under its parent, in any project', () => {
  const rows = [
    mk('p', { state: 'done', lastAt: NOW - 60 * MIN }),
    mk('k', { state: 'working', repo: 'github.com/example/other', cwd: '~/projects/other' }),
    mk('x', { state: 'idle' }),
    mk('y', { state: 'idle' }),
    mk('z', { state: 'idle' }),
  ];
  const groups = groupSessions(rows, { now: NOW, hideDoneAfterHours: 24, inactivePerGroup: 1, parentOf: links({ k: 'p' }) });
  assert.deepEqual(groups.map((g) => g.key), ['app'], 'the child does not open a group of its own');
  const [g] = groups;
  // The parent is done, but it started a working session, so it is active: shown, uncapped.
  assert.deepEqual(ids(groupLayout(g)), ['p', 'x', 'more']);
  assert.deepEqual(ids(childLayout(g, 'p')), ['k']);
  assert.equal(g.activeCount, 1, 'the nested working row counts');
  assert.equal(g.description, '1 working · 3 idle');
  assert.equal(g.collapsed, false);
});

test('groupSessions: a child whose parent is hidden stays where it was', () => {
  const rows = [
    mk('p', { state: 'done', lastAt: NOW - 48 * 60 * MIN }),
    mk('k', { state: 'idle', title: 'step · box' }),
  ];
  const [g] = groupSessions(rows, {
    now: NOW,
    hideDoneAfterHours: 24,
    parentOf: links({ k: 'p' }),
    isDispatched: (s) => s.sessionId === 'k',
  });
  assert.deepEqual(ids(groupLayout(g)), ['dispatched']);
  assert.equal(g.children.size, 0);
});

test('groupSessions: a loop in parent links, or a chain past 32, hides no session', () => {
  const loop = [mk('a', { state: 'needs_you' }), mk('b', { state: 'idle' }), mk('c')];
  const g = groupSessions(loop, { now: NOW, hideDoneAfterHours: 24, parentOf: links({ a: 'b', b: 'a' }) });
  const shown = (gs: ReturnType<typeof groupSessions>) =>
    gs.flatMap((x) => x.sessions.map((s) => s.sessionId)).sort();
  assert.deepEqual(shown(g), ['a', 'b', 'c']);
  assert.equal(tally(g).needsYou, 1);
  const chain = Array.from({ length: 40 }, (_, i) => mk(`n${i}`, { state: i === 39 ? 'needs_you' : 'idle' }));
  const parents: Record<string, string> = {};
  for (let i = 1; i < 40; i++) parents[`n${i}`] = `n${i - 1}`;
  const gc = groupSessions(chain, { now: NOW, hideDoneAfterHours: 24, parentOf: links(parents) });
  const reachable = gc.flatMap((x) => [
    ...groupLayout(x).flatMap((it) => (it.kind === 'session' ? [it.session, ...childLayout(x, it.session.sessionId).map((k) => (k as { session: Session }).session)] : [])),
  ]);
  assert.equal(new Set(reachable.map((s) => s.sessionId)).size, 40, 'every row reachable');
  assert.equal(tally(gc).needsYou, 1);
});

test('refreshDelaySeconds: hidden polls at most once a minute; a bad setting is the default', () => {
  assert.equal(refreshDelaySeconds(20, true), 20);
  assert.equal(refreshDelaySeconds(20, false), 60);
  assert.equal(refreshDelaySeconds(90, false), 90);
  assert.equal(refreshDelaySeconds(2, true), 5);
  assert.equal(refreshDelaySeconds('30', true), 20);
  assert.equal(refreshDelaySeconds(NaN, false), 60);
});

test('tally, badgeTooltip and quietLine summarise every row, nested ones included', () => {
  const rows = [mk('p'), mk('k', { state: 'needs_you' }), mk('w', { state: 'working' }), mk('s', { state: 'working', stale: true })];
  const groups = groupSessions(rows, { now: NOW, hideDoneAfterHours: 24, parentOf: links({ k: 'p' }) });
  assert.deepEqual(tally(groups), { needsYou: 1, working: 1 });
  assert.equal(badgeTooltip(1), '1 session needs you');
  assert.equal(badgeTooltip(3), '3 sessions need you');
  assert.equal(badgeTooltip(0), null);
  assert.equal(quietLine(groups), null, 'the badge says it');
  const calm = groupSessions([mk('w', { state: 'working' })], { now: NOW, hideDoneAfterHours: 24 });
  assert.equal(quietLine(calm), 'Nothing needs you · 1 working');
  assert.equal(quietLine(groupSessions([mk('i')], { now: NOW, hideDoneAfterHours: 24 })), 'All quiet in the fold: nothing needs you.');
  assert.equal(quietLine([]), null);
});

test('nudgeFor: only changes since a seen state; needing you wins over finishing', () => {
  const before = stateMap([mk('a', { state: 'working' }), mk('b', { state: 'working' }), mk('c', { state: 'needs_you' })]);
  assert.equal(nudgeFor(new Map(), [mk('a', { state: 'needs_you' })]), null, 'the first load nudges nothing');
  assert.deepEqual(nudgeFor(before, [mk('new', { state: 'needs_you' })])?.sessions.map((x) => x.sessionId), ['new'], 'new and waiting');
  assert.equal(nudgeFor(before, [mk('new', { state: 'working' })]), null, 'new and working: no nudge');
  const fin = nudgeFor(before, [mk('a', { state: 'done' }), mk('b', { state: 'working' }), mk('c', { state: 'needs_you' })]);
  assert.equal(fin?.kind, 'finished');
  assert.deepEqual(fin?.sessions.map((s) => s.sessionId), ['a']);
  const need = nudgeFor(before, [mk('a', { state: 'done' }), mk('b', { state: 'needs_you' })]);
  assert.equal(need?.kind, 'needsYou');
  assert.deepEqual(need?.sessions.map((s) => s.sessionId), ['b']);
  assert.equal(nudgeFor(before, [mk('a', { state: 'idle' })]), null, 'working to idle is not finishing');
  assert.equal(nudgeFor(before, [mk('c', { state: 'needs_you' })]), null, 'still waiting: no second nudge');
  assert.equal(nudgeFor(stateMap([mk('a', { state: 'working', stale: true })]), [mk('a', { state: 'needs_you' })])?.kind, 'needsYou');
});

test('nudgeText names one session, counts several', () => {
  const label = (s: Session) => s.title ?? s.sessionId;
  assert.equal(nudgeText({ kind: 'needsYou', sessions: [mk('a', { title: 'app: login' })] }, label), '$(bell) Baa, app: login needs you');
  assert.equal(nudgeText({ kind: 'needsYou', sessions: [mk('a'), mk('b')] }, label), '$(bell) Baa, 2 sessions need you');
  assert.equal(nudgeText({ kind: 'finished', sessions: [mk('a', { title: 'app: login' })] }, label), '$(check) Back in the fold: app: login');
  assert.equal(nudgeText({ kind: 'finished', sessions: [mk('a'), mk('b'), mk('c')] }, label), '$(check) 3 sessions back in the fold');
});

test('ChildLinks reads ~/.sheepfold/children, skips bad files, follows changes', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sheepfold-links-'));
  const dir = childLinksDir(home);
  const links = new ChildLinks(dir);
  assert.equal(links.read().size, 0, 'no directory yet');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'child-1.json'), JSON.stringify({ parent: 'parent-1' }));
  fs.writeFileSync(path.join(dir, 'child-2.json'), '{not json');
  fs.writeFileSync(path.join(dir, 'self.json'), JSON.stringify({ parent: 'self' }));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
  assert.deepEqual([...links.read()], [['child-1', 'parent-1']]);
  fs.rmSync(path.join(dir, 'child-1.json'));
  assert.equal(links.read().size, 0, 'a removed file drops its link');
  assert.equal(parseChildLink('{"parent": "  p  "}'), 'p');
  assert.equal(parseChildLink('{"parent": ""}'), null);
  assert.equal(parseChildLink('[]'), null);
  fs.rmSync(home, { recursive: true, force: true });
});
