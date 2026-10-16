// The filesystem side of Sheepfold: where Claude Code keeps a session's transcript, and whether
// it holds a real user message. Node's fs only (no `vscode`), so `node --test` covers it against
// a temp directory. `classify` in model.ts takes these functions as injected parts.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { samePending } from './model';
import type { PendingOpen, TranscriptInfo } from './model';

/** Scan this much of a transcript for the first user message. */
export const SCAN_LIMIT = 512 * 1024;
const CHUNK = 64 * 1024;
/**
 * Keep this much of the first user message: a label shows 60 characters, and a first prompt can
 * be a pasted file, held in memory for every session in the list.
 */
export const FIRST_USER_MAX = 200;

export interface CliSettings {
  /** The name the CLI reports this host under (`connect <key> <name>`, `--machine`); null: the hostname. */
  machine: string | null;
  /** The web app's origin when it is not spacesheep.dev; null: the default. */
  appOrigin: string | null;
}

/**
 * The two settings Sheepfold shares with the spacesheep CLI, read as the CLI reads them: its
 * config in `$SPACESHEEP_CONFIG_DIR`, else `$XDG_CONFIG_HOME/spacesheep`, else
 * `~/.config/spacesheep`; `$SPACESHEEP_APP_ORIGIN` over the file's `appOrigin`. Only these two
 * fields are read out of the file; the key beside them never leaves this function.
 */
export function readCliSettings(env: NodeJS.ProcessEnv, home: string): CliSettings {
  const dir = env.SPACESHEEP_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'spacesheep');
  let file: { machine?: unknown; appOrigin?: unknown } = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) ?? {};
  } catch {
    // no config: the CLI's defaults
  }
  // Exactly as the CLI takes them: untrimmed (it reports the machine as saved), one trailing
  // slash off the origin.
  const pick = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  const origin = pick(env.SPACESHEEP_APP_ORIGIN) ?? pick(file.appOrigin);
  return { machine: pick(file.machine), appOrigin: origin ? origin.replace(/\/$/, '') : null };
}

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

/** At most `max` UTF-16 units, never half a surrogate pair. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
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
      firstUser = clip(t.replace(/\s+/g, ' ').trim(), FIRST_USER_MAX);
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
 * The folder name Claude Code keeps a cwd's transcripts under, `<configDir>/projects/<name>`:
 * every character but an ASCII letter or digit becomes `-` (`/a/b_c` → `-a-b-c`, `C:\\x` →
 * `C--x`). A very long cwd is shortened by Claude Code in a way not reproduced here; that lookup
 * misses and the listing finds it.
 */
export function projectDirName(cwd: string): string {
  return cwd.replace(/(.)[\\/]+$/, '$1').replace(/[^A-Za-z0-9]/g, '-');
}

const NOT_FOUND: TranscriptInfo = { found: false, hasUser: false, firstUser: null, entrypoint: null };

interface Scan {
  mtimeMs: number;
  size: number;
  info: TranscriptInfo;
  /** Appending cannot change it: the first user message was found, or the scan read its limit. */
  finished: boolean;
}

/**
 * Finds `<configDir>/projects/<encoded dir>/<id>.jsonl` and scans it. Where it looks, cheapest
 * first: the path it found last time, then the folder the session's cwd encodes to, and only
 * then a listing of every project folder, built at most once per `reset()` (call it at each
 * refresh). A scan is cached per path and redone when the file changes, except a finished one
 * (see `Scan`), kept while the file only grows: Claude Code appends to a transcript, and a
 * working session's grows at every turn. Entries not looked up between two resets are dropped.
 */
export class TranscriptIndex {
  private byId: Map<string, string> | null = null;
  /** id → transcript path, from earlier lookups. */
  private known = new Map<string, string>();
  private scans = new Map<string, Scan>();
  private touched = new Set<string>();
  /** How many listings and scans ran; for tests. */
  readonly stats = { listings: 0, scans: 0 };

  constructor(private configDir: string) {}

  setConfigDir(dir: string): void {
    if (dir !== this.configDir) {
      this.configDir = dir;
      this.scans.clear();
      this.known.clear();
    }
    this.reset();
  }

  reset(): void {
    this.byId = null;
    for (const file of [...this.scans.keys()]) if (!this.touched.has(file)) this.scans.delete(file);
    for (const [id, file] of [...this.known]) if (!this.touched.has(file)) this.known.delete(id);
    this.touched.clear();
  }

  private list(): Map<string, string> {
    if (this.byId) return this.byId;
    this.stats.listings++;
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

  private locate(sessionId: string, cwd: string | null): { file: string; st: fs.Stats } | null {
    // An id names a file here only when it is a plain name: `../` would read outside projects/.
    const direct = cwd && /^[\w-]+$/.test(sessionId) ? path.join(this.configDir, 'projects', projectDirName(cwd), `${sessionId}.jsonl`) : null;
    for (const file of [this.known.get(sessionId), direct]) {
      const st = file ? statFile(file) : null;
      if (file && st) {
        this.known.set(sessionId, file);
        return { file, st };
      }
    }
    this.known.delete(sessionId);
    const listed = this.list().get(sessionId);
    const st = listed ? statFile(listed) : null;
    if (!listed || !st) return null;
    this.known.set(sessionId, listed);
    return { file: listed, st };
  }

  /** The transcript's path, or null. `cwd`: the session's folder, home expanded. */
  find(sessionId: string, cwd: string | null = null): string | null {
    return this.locate(sessionId, cwd)?.file ?? null;
  }

  info(sessionId: string, cwd: string | null = null): TranscriptInfo {
    const hit = this.locate(sessionId, cwd);
    if (!hit) return NOT_FOUND;
    const { file, st } = hit;
    this.touched.add(file);
    const prev = this.scans.get(file);
    if (prev && ((prev.mtimeMs === st.mtimeMs && prev.size === st.size) || (prev.finished && st.size >= prev.size))) {
      return prev.info;
    }
    this.stats.scans++;
    const info = scanTranscript(file);
    // The file only grows, so past SCAN_LIMIT bytes the scan has read all it ever will (at exactly
    // the limit, `scanTranscript` has not yet counted the rest as a user line).
    const finished = info.found && (info.firstUser !== null || st.size > SCAN_LIMIT);
    this.scans.set(file, { mtimeMs: st.mtimeMs, size: st.size, info, finished });
    return info;
  }
}

function statFile(file: string): fs.Stats | null {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? st : null;
  } catch {
    return null;
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
 * child id → parent id, from the link files. A file is read once and cached by name, mtime and
 * size, so a refresh costs one directory listing and a stat per file. An unreadable or malformed
 * file is skipped and never cached: a launcher caught mid-write leaves a half file whose mtime
 * may not move again within the clock's resolution, and a cached failure would hide its link.
 */
export class ChildLinks {
  private cache = new Map<string, { mtimeMs: number; size: number; parent: string }>();

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
      const st = statFile(file);
      if (!st) continue;
      let hit = this.cache.get(name);
      if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
        const parent = parseChildLink(readText(file));
        hit = parent ? { mtimeMs: st.mtimeMs, size: st.size, parent } : undefined;
        if (hit) this.cache.set(name, hit);
        else this.cache.delete(name);
      }
      if (hit && hit.parent !== m[1]) out.set(m[1], hit.parent);
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

/**
 * Delete the pending open only if it is still `p`: a newer click may have replaced it, and that
 * one belongs to its own window. Returns whether it was there to delete.
 */
export function deletePendingIf(home: string, p: PendingOpen): boolean {
  if (!samePending(readPending(home), p)) return false;
  deletePending(home);
  return true;
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
