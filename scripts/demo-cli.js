#!/usr/bin/env node
// A stand-in for `spacesheep sessions list`: synthetic sessions for screenshots and the demo GIF,
// so no real session title ever reaches a picture. Point `sheepfold.cli` at this file (and set
// `sheepfold.refreshSeconds` to 5). It runs a 60-second loop: "app: login" works for 20 s, then
// needs you; 20 s later "docs: changelog" finishes. Each change is a nudge in the status bar.
// Standard library only; the only argument it honours is the CLI's own `sessions list`.

'use strict';

const now = Date.now();
const phase = Math.floor((now % 60_000) / 20_000); // 0, 1, 2
const min = 60_000;

function row(id, over) {
  return {
    source: 'claude-code',
    session_id: id,
    machine: null, // this machine
    cwd: '~/projects/app',
    repo: 'github.com/example/app',
    branch: 'main',
    model: 'claude-opus',
    title: null,
    first_ask: null,
    url: null,
    state: 'idle',
    last_at: now - 30 * min,
    last_tool: null,
    stale: false,
    turns: 6,
    parent_id: null,
    ...over,
  };
}

const sessions = [
  row('demo-0001', { title: 'app: login', state: phase === 0 ? 'working' : 'needs_you', last_at: now - 1 * min, last_tool: 'Bash' }),
  row('demo-0002', { title: 'app: checkout tests', state: 'working', last_at: now - 2 * min, last_tool: 'Edit' }),
  row('demo-0003', { title: 'app: release 2.4', state: 'idle', last_at: now - 40 * min }),
  row('demo-0004', { title: 'app: release 2.4 · step 2', state: 'working', last_at: now - 3 * min, parent_id: 'demo-0003' }),
  row('demo-0005', { title: 'app: flaky retry', state: 'done', last_at: now - 3 * 60 * min }),
  row('demo-0006', { title: 'app: dark mode', state: 'idle', last_at: now - 5 * 60 * min }),
  row('demo-0007', { title: 'app: onboarding copy', state: 'done', last_at: now - 7 * 60 * min }),
  row('demo-0008', { title: 'app: icons', state: 'done', last_at: now - 9 * 60 * min }),
  row('demo-0009', { title: 'app: error pages', state: 'done', last_at: now - 11 * 60 * min }),
  row('demo-0010', { title: 'api: rate limits', state: 'needs_you', last_at: now - 6 * min, cwd: '~/projects/api', repo: 'github.com/example/api', machine: 'server' }),
  row('demo-0011', { title: 'api: schema migration', state: 'idle', last_at: now - 50 * min, cwd: '~/projects/api', repo: 'github.com/example/api' }),
  row('demo-0012', { title: 'docs: changelog', state: phase === 2 ? 'done' : 'working', last_at: now - 4 * min, cwd: '~/projects/docs', repo: 'github.com/example/docs' }),
];

if (process.argv[2] !== 'sessions' || process.argv[3] !== 'list') {
  process.stderr.write('demo-cli: only `sessions list` is simulated\n');
  process.exit(2);
}
process.stdout.write(JSON.stringify({ sessions, now }, null, 1) + '\n');
