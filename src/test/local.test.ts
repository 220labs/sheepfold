import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  REMOTE_WRITE_COMMAND,
  SCAN_LIMIT,
  TranscriptIndex,
  deletePending,
  dirExists,
  pendingFile,
  readPending,
  scanTranscript,
  writePending,
  writePendingOverSsh,
} from '../local';
import { decidePending } from '../model';

// Synthetic transcripts in a temp dir; nothing here is real session data.
function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sheepfold-test-'));
}

function writeTranscript(configDir: string, project: string, id: string, lines: unknown[]): string {
  const dir = path.join(configDir, 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}

const user = (text: unknown, extra: object = {}) => ({ type: 'user', message: { role: 'user', content: text }, ...extra });

test('finds a transcript under any project dir and reads the first real user message', () => {
  const cfg = tmp();
  writeTranscript(cfg, '-proj-a', 'id-a', [
    { type: 'summary', summary: 'x' },
    user('caveat text', { isMeta: true }),
    user([{ type: 'text', text: 'Please  fix\nthe build' }]),
    user('second'),
  ]);
  writeTranscript(cfg, '-proj-b', 'id-b', [{ type: 'assistant', message: {} }]);
  const idx = new TranscriptIndex(cfg);
  assert.deepEqual(idx.info('id-a'), { found: true, hasUser: true, firstUser: 'Please  fix\nthe build', entrypoint: null });
  assert.deepEqual(idx.info('id-b'), { found: true, hasUser: false, firstUser: null, entrypoint: null });
  assert.deepEqual(idx.info('nope'), { found: false, hasUser: false, firstUser: null, entrypoint: null });
  assert.ok(idx.find('id-a')?.endsWith(path.join('-proj-a', 'id-a.jsonl')));
});

test('meta-only and tool-result-only transcripts', () => {
  const cfg = tmp();
  writeTranscript(cfg, 'p', 'meta', [user('x', { isMeta: true })]);
  writeTranscript(cfg, 'p', 'cmd', [user('<command-name>/clear</command-name>')]);
  const idx = new TranscriptIndex(cfg);
  assert.equal(idx.info('meta').hasUser, false);
  // a slash-command line is a real user line but a poor label
  assert.deepEqual(idx.info('cmd'), { found: true, hasUser: true, firstUser: null, entrypoint: null });
});

test('a missing config dir finds nothing, and does not throw', () => {
  const idx = new TranscriptIndex(path.join(tmp(), 'absent'));
  assert.equal(idx.info('x').found, false);
});

test('the listing is cached until reset(); scans are cached per mtime', () => {
  const cfg = tmp();
  const idx = new TranscriptIndex(cfg);
  assert.equal(idx.find('late'), null);
  const file = writeTranscript(cfg, 'p', 'late', [user('first')]);
  assert.equal(idx.find('late'), null, 'cached listing');
  idx.reset();
  assert.equal(idx.info('late').firstUser, 'first');
  // rewrite with a different mtime: the scan is redone
  fs.writeFileSync(file, JSON.stringify(user('changed')) + '\n');
  fs.utimesSync(file, new Date(2030, 0, 1), new Date(2030, 0, 1));
  assert.equal(idx.info('late').firstUser, 'changed');
});

test('the scan stops at the limit; a big file with nothing found counts as non-empty', () => {
  const cfg = tmp();
  const filler = JSON.stringify({ type: 'assistant', message: { content: 'y'.repeat(1000) } });
  const lines: string[] = [];
  for (let i = 0; i < Math.ceil(SCAN_LIMIT / filler.length) + 10; i++) lines.push(filler);
  const big = writeTranscript(cfg, 'p', 'big', lines);
  assert.deepEqual(scanTranscript(big), { found: true, hasUser: true, firstUser: null, entrypoint: null });
  // a user line past the limit is not read, but the big-file rule still says non-empty
  const late = writeTranscript(cfg, 'p', 'big-late', [...lines, user('too late')]);
  assert.equal(scanTranscript(late).firstUser, null);
});

test('a final line without a trailing newline, and a line longer than a chunk', () => {
  const cfg = tmp();
  const dir = path.join(cfg, 'projects', 'p');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'nonl.jsonl'), JSON.stringify(user('no newline')));
  const wide = JSON.stringify({ type: 'assistant', message: { content: 'z'.repeat(100_000) } });
  fs.writeFileSync(path.join(dir, 'wide.jsonl'), wide + '\n' + JSON.stringify(user('after wide')) + '\n');
  fs.writeFileSync(path.join(dir, 'utf.jsonl'), JSON.stringify(user('naïve — ünï')) + '\n');
  const idx = new TranscriptIndex(cfg);
  assert.equal(idx.info('nonl').firstUser, 'no newline');
  assert.equal(idx.info('wide').firstUser, 'after wide');
  assert.equal(idx.info('utf').firstUser, 'naïve — ünï');
});

test('dirExists', () => {
  const d = tmp();
  assert.equal(dirExists(d), true);
  assert.equal(dirExists(path.join(d, 'nope')), false);
  const f = path.join(d, 'file');
  fs.writeFileSync(f, '');
  assert.equal(dirExists(f), false);
});

test('setConfigDir switches the lookup', () => {
  const a = tmp();
  const b = tmp();
  writeTranscript(b, 'p', 'only-b', [user('hi')]);
  const idx = new TranscriptIndex(a);
  assert.equal(idx.info('only-b').found, false);
  idx.setConfigDir(b);
  assert.equal(idx.info('only-b').found, true);
});

test('pending file: write (atomic, creates the dir), read, delete', () => {
  const home = tmp();
  assert.equal(readPending(home), undefined);
  const p = { sessionId: 'id-1', folder: '/work/app', at: 1_800_000_000_000 };
  writePending(home, p);
  assert.deepEqual(readPending(home), p);
  assert.deepEqual(fs.readdirSync(path.dirname(pendingFile(home))), ['pending.json'], 'no tmp file left behind');
  writePending(home, { ...p, sessionId: 'id-2' });
  assert.equal((readPending(home) as { sessionId: string }).sessionId, 'id-2');
  deletePending(home);
  assert.equal(readPending(home), undefined);
  deletePending(home); // already gone: no throw
});

test('pending file: unreadable JSON reads as null, which decidePending clears', () => {
  const home = tmp();
  fs.mkdirSync(path.dirname(pendingFile(home)), { recursive: true });
  fs.writeFileSync(pendingFile(home), '{not json');
  assert.equal(readPending(home), null);
  assert.deepEqual(decidePending(readPending(home), 1, ['/x']), { run: null, clear: true });
});

test('pending file feeds decidePending: fires for this window, expires after two minutes', () => {
  const home = tmp();
  const at = 1_800_000_000_000;
  writePending(home, { sessionId: 'id', folder: '/work/app', at });
  assert.equal(decidePending(readPending(home), at + 1000, ['/work/app']).run?.sessionId, 'id');
  assert.deepEqual(decidePending(readPending(home), at + 121_000, ['/work/app']), { run: null, clear: true });
});

// A stand-in `ssh`: runs its last argument (the remote command) in a shell with HOME set to a
// temp "remote home", stdin passed through. Exercises the real command string end to end.
function fakeSsh(dir: string, body: string): string {
  const file = path.join(dir, 'fake-ssh');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

test('writePendingOverSsh: sends the JSON on stdin through BatchMode ssh', async () => {
  const bin = tmp();
  const remoteHome = tmp();
  const argsFile = path.join(bin, 'args');
  const ssh = fakeSsh(
    bin,
    `printf '%s\\n' "$@" > '${argsFile}'\nfor a; do cmd="$a"; done\nHOME='${remoteHome}' exec sh -c "$cmd"`,
  );
  const p = { sessionId: 'id-r', folder: '/srv/app', at: 5 };
  await writePendingOverSsh('server', p, ssh);
  assert.deepEqual(readPending(remoteHome), p);
  const args = fs.readFileSync(argsFile, 'utf8').split('\n');
  assert.deepEqual(args.slice(0, 5), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'server']);
  assert.equal(args[5], REMOTE_WRITE_COMMAND);
});

test('writePendingOverSsh: rejects with the first line of ssh\'s error', async () => {
  const bin = tmp();
  const ssh = fakeSsh(bin, `echo 'Permission denied (publickey).' >&2\necho more >&2\nexit 255`);
  await assert.rejects(writePendingOverSsh('server', { sessionId: 'a', folder: '/f', at: 1 }, ssh), {
    message: 'Permission denied (publickey).',
  });
  await assert.rejects(writePendingOverSsh('server', { sessionId: 'a', folder: '/f', at: 1 }, path.join(bin, 'missing')), {
    message: 'ssh not found',
  });
  await assert.rejects(writePendingOverSsh('-oProxyCommand=x', { sessionId: 'a', folder: '/f', at: 1 }, ssh), /invalid ssh host/);
});

test('scan returns the first entrypoint a line carries', () => {
  const cfg = tmp();
  writeTranscript(cfg, 'p', 'sdk', [
    { type: 'summary' },
    user('go', { entrypoint: 'sdk-cli' }),
    user('later', { entrypoint: 'cli' }),
  ]);
  writeTranscript(cfg, 'p', 'plain', [user('hi', { entrypoint: 'cli' })]);
  writeTranscript(cfg, 'p', 'none', [user('hi')]);
  const idx = new TranscriptIndex(cfg);
  assert.equal(idx.info('sdk').entrypoint, 'sdk-cli');
  assert.equal(idx.info('plain').entrypoint, 'cli');
  assert.equal(idx.info('none').entrypoint, null);
});
