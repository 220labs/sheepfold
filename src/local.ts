// The filesystem side of Sheepfold: where Claude Code keeps a session's transcript, and whether
// it holds a real user message. Node's fs only (no `vscode`), so `node --test` covers it against
// a temp directory. `classify` in model.ts takes these functions as injected parts.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import type { PendingOpen, TranscriptInfo } from './model';

/** Scan this much of a transcript for the first user message. */
export const SCAN_LIMIT = 512 * 1024;
const CHUNK = 64 * 1024;

export function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Text of a transcript user line's message: a string, or the text parts of a content array. */
function userText(line: Record<string, unknown>): string {
  const msg = line.message as { content?: unknown } | undefined;
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((part) => {
        const p = part as { type?: unknown; text?: unknown } | null;
        return p && p.type === 'text' && typeof p.text === 'string' ? p.text : '';
      })
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

// Slash-command bookkeeping lines are user lines but make a poor label.
function isCommandNoise(text: string): boolean {
  return /^\s*<(command-|local-command)/.test(text);
}

const USER_TYPE = /"type"\s*:\s*"user"/;
const ENTRYPOINT = /"entrypoint"\s*:\s*"([^"]*)"/;

/**
 * Scan the first SCAN_LIMIT bytes for a user line that is not `isMeta`. `firstUser` is the first
 * such line with usable text. A file bigger than the limit with nothing found in it is assumed to
 * hold a message (an oversized early line must not hide a real session).
 */
export function scanTranscript(file: string): TranscriptInfo {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { found: false, hasUser: false, firstUser: null, entrypoint: null };
  }
  let hasUser = false;
  let firstUser: string | null = null;
  let entrypoint: string | null = null;
  const handle = (text: string): boolean => {
    if (entrypoint === null) entrypoint = ENTRYPOINT.exec(text)?.[1] ?? null;
    if (!USER_TYPE.test(text)) return false;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return false;
    }
    if (obj.type !== 'user' || obj.isMeta === true) return false;
    hasUser = true;
    const t = userText(obj);
    if (t && !isCommandNoise(t)) {
      firstUser = t;
      return true; // got everything we want
    }
    return false;
  };
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(CHUNK);
    let leftover: Buffer = Buffer.alloc(0);
    let read = 0;
    let done = false;
    while (!done && read < SCAN_LIMIT) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, SCAN_LIMIT - read), read);
      if (n <= 0) break;
      read += n;
      const data = Buffer.concat([leftover, buf.subarray(0, n)]);
      const cut = data.lastIndexOf(0x0a);
      if (cut < 0) {
        leftover = data;
        continue;
      }
      for (const line of data.subarray(0, cut).toString('utf8').split('\n')) {
        if (line && handle(line)) {
          done = true;
          break;
        }
      }
      leftover = data.subarray(cut + 1);
    }
    // The tail after the last newline is a whole line only if we reached the end of the file.
    if (!done && read >= size && leftover.length) handle(leftover.toString('utf8'));
    if (!hasUser && size > SCAN_LIMIT) hasUser = true;
  } catch {
    // unreadable: report what we have
  } finally {
    fs.closeSync(fd);
  }
  return { found: true, hasUser, firstUser, entrypoint };
}

/**
 * Finds `<configDir>/projects/<encoded dir>/<id>.jsonl` and scans it. The directory listing is
 * built once per `reset()` (call it at each refresh); scan results are cached per (path, mtime).
 */
export class TranscriptIndex {
  private byId: Map<string, string> | null = null;
  private scans = new Map<string, { mtimeMs: number; size: number; info: TranscriptInfo }>();

  constructor(private configDir: string) {}

  setConfigDir(dir: string): void {
    if (dir !== this.configDir) {
      this.configDir = dir;
      this.scans.clear();
    }
    this.reset();
  }

  reset(): void {
    this.byId = null;
  }

  private list(): Map<string, string> {
    if (this.byId) return this.byId;
    const map = new Map<string, string>();
    const root = path.join(this.configDir, 'projects');
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(root);
    } catch {
      // no projects dir: nothing found
    }
    for (const d of dirs) {
      let files: string[];
      try {
        files = fs.readdirSync(path.join(root, d));
      } catch {
        continue; // a plain file, or unreadable
      }
      for (const f of files) {
        if (f.endsWith('.jsonl')) {
          const id = f.slice(0, -'.jsonl'.length);
          if (!map.has(id)) map.set(id, path.join(root, d, f));
        }
      }
    }
    this.byId = map;
    return map;
  }

  /** The transcript's path, or null. */
  find(sessionId: string): string | null {
    return this.list().get(sessionId) ?? null;
  }

  info(sessionId: string): TranscriptInfo {
    const file = this.find(sessionId);
    if (!file) return { found: false, hasUser: false, firstUser: null, entrypoint: null };
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return { found: false, hasUser: false, firstUser: null, entrypoint: null };
    }
    const hit = this.scans.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.info;
    const info = scanTranscript(file);
    this.scans.set(file, { mtimeMs: st.mtimeMs, size: st.size, info });
    return info;
  }
}

// ---------------------------------------------------------------------------------------------
// Child links: which session started which. Any launcher that starts a session for another one
// writes `~/.sheepfold/children/<child session id>.json` holding `{"parent": "<session id>"}`
// on the machine where the parent runs. Sheepfold only reads them; the launcher owns pruning.

export function childLinksDir(home: string): string {
  return path.join(home, '.sheepfold', 'children');
}

const LINK_FILE = /^([A-Za-z0-9_-]{1,128})\.json$/;

/**
 * child id → parent id, from the link files. A file is read once and cached by name and mtime,
 * so a refresh costs one directory listing. Unreadable or malformed files are skipped.
 */
export class ChildLinks {
  private cache = new Map<string, { mtimeMs: number; parent: string | null }>();

  constructor(private readonly dir: string) {}

  read(): Map<string, string> {
    const out = new Map<string, string>();
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return out; // no directory: no links
    }
    const seen = new Set<string>();
    for (const name of names) {
      const m = LINK_FILE.exec(name);
      if (!m) continue;
      seen.add(name);
      const file = path.join(this.dir, name);
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      let hit = this.cache.get(name);
      if (!hit || hit.mtimeMs !== mtimeMs) {
        hit = { mtimeMs, parent: parseChildLink(readText(file)) };
        this.cache.set(name, hit);
      }
      if (hit.parent && hit.parent !== m[1]) out.set(m[1], hit.parent);
    }
    for (const name of [...this.cache.keys()]) if (!seen.has(name)) this.cache.delete(name);
    return out;
  }
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** The `parent` of a link file's JSON, or null. */
export function parseChildLink(text: string): string | null {
  try {
    const v = JSON.parse(text) as { parent?: unknown } | null;
    return v && typeof v.parent === 'string' && v.parent.trim() !== '' ? v.parent.trim() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The pending-open hand-over: a file on the host where the target window's extension runs.
// (VS Code's globalState is per profile, and a new window may open in another profile.)

export function pendingFile(home: string): string {
  return path.join(home, '.sheepfold', 'pending.json');
}

/** Write the pending open atomically (tmp + rename), creating `~/.sheepfold`. */
export function writePending(home: string, p: PendingOpen): void {
  const file = pendingFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p));
  fs.renameSync(tmp, file);
}

/** The file's parsed JSON; undefined when there is none, null when it is unreadable. */
export function readPending(home: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(pendingFile(home), 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function deletePending(home: string): void {
  try {
    fs.unlinkSync(pendingFile(home));
  } catch {
    // already gone
  }
}

/** What the remote runs to store the pending open; the JSON arrives on stdin. */
export const REMOTE_WRITE_COMMAND =
  'mkdir -p ~/.sheepfold && cat > ~/.sheepfold/pending.json.tmp && mv ~/.sheepfold/pending.json.tmp ~/.sheepfold/pending.json';

/**
 * Write the pending open on another host over ssh (key access only: BatchMode never prompts).
 * Rejects with the first line of ssh's error. `sshCommand` is injectable for tests.
 */
export function writePendingOverSsh(sshHost: string, p: PendingOpen, sshCommand = 'ssh'): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!sshHost || sshHost.startsWith('-')) {
      reject(new Error(`invalid ssh host "${sshHost}"`));
      return;
    }
    const child = execFile(
      sshCommand,
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', sshHost, REMOTE_WRITE_COMMAND],
      { timeout: 20_000, windowsHide: true },
      (err, _stdout, stderr) => {
        if (!err) {
          resolve();
          return;
        }
        const line = String(stderr).split(/\r?\n/).map((l) => l.trim()).find(Boolean);
        const notFound = (err as NodeJS.ErrnoException).code === 'ENOENT';
        reject(new Error(line ?? (notFound ? 'ssh not found' : err.message)));
      },
    );
    // A missing ssh surfaces through the callback; a closed pipe must not throw here.
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(p));
  });
}
