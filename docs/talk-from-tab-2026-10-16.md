# Messages to a session from a VS Code tab — a proposal to spacesheep, 2026-10-16

Status: proposal, to be sent to spacesheep once public; Sheepfold's stopgap built (0.6.0, "Open
in Browser").

Sheepfold opens a session's spacesheep page in a VS Code tab through the CLI's mirror
(`spacesheep mirror`, `docs/inline-view-2026-10-11.md`). The page reads fine there, but its
Session tab cannot send a message to the session. This doc says why, proposes a fix on
spacesheep's side that needs no change to sessionpipe, and records the stopgap Sheepfold ships
until then.

## Why sending fails in a tab

The Session tab signs every message, and the sessionpipe daemon on the session's machine checks
the signature against a passkey enrolled at its terminal. The page does it in two steps: a
passkey assertion approves a 24-hour ECDSA key the page makes for itself (a grant: `{v, t, pub,
iat, exp, rp}`), and that key signs each message.

In a tab the page is served by the mirror from `http://localhost:4280`. Two checks refuse it:

1. **The browser.** The page calls `navigator.credentials.get({ publicKey: { rpId } })` with the
   `rp_id` from `/api/machines`, which is `spacesheep.dev` through the mirror too (read
   2026-10-16). WebAuthn rejects an `rpId` that is not the page's own host or a registrable
   suffix of it, and `spacesheep.dev` is neither for `localhost`: the passkey prompt never
   appears.
2. **The daemon.** sessionpipe 0.5.0 accepts an assertion only when `clientData.origin` is on
   the receiver's `rpId` or a subdomain of it — `https:`, or `http:` only for an `rpId` of
   `localhost` (`originAllowed`; the reply is "the passkey was used on another site") — and
   refuses one made inside another site's frame (`crossOrigin`). A receiver has one `rpId`,
   discovered from the site: `spacesheep.dev`. So a passkey for `localhost` would fail here
   instead, and would mean enrolling a second passkey per machine besides.

The same holds for the mirror's page opened in a desktop browser (VS Code's own "open in
browser" button on the tab), and in a Remote-SSH window. A passkey is bound to its site; no
setting on Sheepfold's side changes that.

Not observed: a Send pressed in a tab. The two refusals are read from the page's script, the
mirror (`lib/mirror.js`, CLI 1.30.0) and the daemon (sessionpipe 0.5.0's `cli.js`), plus the live
`/api/machines` answer through the mirror.

## Proposal: approve the tab's key from the browser

The grant already separates the passkey from the key that signs. The key can be made anywhere;
only the assertion over the grant has to happen on spacesheep.dev. So:

1. In the mirrored page, when the Session tab needs a grant and `location.hostname` is not the
   `rp_id`, it makes its key pair as it does now (non-extractable, in its own IndexedDB) and
   builds the grant string with `rp: rp_id`.
2. It asks the server for an approval: `POST /api/grants/pending { grant }` (through the
   mirror, so on the CLI's own signed-in session) and gets back `{ code }`, short-lived (five
   minutes) and one-use.
3. It shows "Approve this tab in your browser", the code, and a button that opens
   `https://${rp_id}/approve/${code}` in a new window. The page builds that URL itself, at run
   time: the mirror rewrites every `//spacesheep.dev` it finds in a page, script or JSON answer
   to its own `localhost` address, so a URL the server sent, or one written out in the script,
   would open the approve page on `localhost`, where the passkey cannot be used. (The bare
   `rp_id` survives the mirror for the same reason: no `//` in front.) In VS Code the new
   window should be the system browser; untested, and Sheepfold's "Open in Browser" (below) is
   the fallback.
4. The approve page, signed in as the same account, shows what it approves — the machine(s),
   "a VS Code tab", the code to compare, the expiry — and on a click runs the passkey assertion
   over the grant's hash, exactly as the Session tab does today. It posts the assertion to
   `POST /api/grants/pending/<code>`.
5. The mirrored page polls `GET /api/grants/pending/<code>` and, once the assertion is there,
   holds a grant it uses like any other until it expires.

Why this and not the alternatives:

- **No sessionpipe change.** The assertion's `clientData.origin` is `https://spacesheep.dev`
  and the grant's `rp` is the receiver's `rpId`, so `originAllowed` and `parseGrant` pass as
  they are; the daemon never sees where the grant's key lives.
- **Same trust as today.** A message still needs a passkey the owner enrolled at the terminal;
  the tab only borrows a 24-hour key approved by touching it, as a phone does.
- **One touch a day per tab origin**, not one per message.

Guards the approve flow needs:

- **The code comparison is the guard.** The mirror lends the account's session to whatever
  reaches it, so anything that can call the mirror could file a pending approval for a key of
  its own and open its approve page, and the owner's touch would grant that key. What stops it
  is the owner checking that the code on the approve page is the one the tab shows. The approve
  page puts the code first and acts only on a click (a passkey prompt that appears unasked is
  easy to approve by reflex). A grant someone else collects is useless without the private key
  it names, so approving the right code is enough.
- The pending approval belongs to the account that created it: another account cannot read or
  complete it.
- This leans on the mirror answering only its own pages; the mirror findings sent privately on
  2026-10-11 bear on that and are worth closing first.

Rejected:

- **The mirror signs for the tab**, with a local key enrolled through the daemon's `key.add`:
  needs a non-passkey key type in sessionpipe, and makes every local process that can reach the
  mirror able to message every session.
- **A passkey for `localhost`**: a second passkey per machine, a daemon change to accept a
  second `rpId`, and inside Simple Browser's frame (which sets no `publickey-credentials-get`
  permission) the daemon would refuse the assertion as `crossOrigin` anyway.

## Open: VS Code's integrated browser (1.142)

The mirror exists because spacesheep.dev refuses to be framed, and Simple Browser is a frame.
VS Code 1.142 sends `simpleBrowser.show` to its own integrated browser instead
(`workbench.action.browser.open`, an editor of its own with persistent storage), which looks
like a top-level browser view rather than a frame. If it is, spacesheep.dev may load in it
directly, signed in once, and its passkey may work there with no mirror and no change on
spacesheep's side — for VS Code 1.142 and later. Untested: loading the page, signing in
(Google may refuse an embedded browser), and WebAuthn inside Electron. Until that is tried, this
proposal stands for the mirror, which every other editor (older VS Code, Cursor, VSCodium) still
needs.

## The stopgap in Sheepfold (0.6.0)

Until the tab can send, Sheepfold opens the session on spacesheep.dev in the browser on request:

- A button in the title bar of the tab a session page opened in (the integrated browser, or
  Simple Browser before 1.142), "Open in Browser (to send it messages)". VS Code tells an
  extension no tab's URL, so Sheepfold remembers which tab it opened each session in and shows
  the button only there; a link followed inside the tab is not seen.
- "Open in Browser" on a session row's menu, beside "Show on spacesheep".

Both build the URL from the site the CLI points at, never from the mirror's address. Nothing
else changes: a click still opens the tab.

## Decisions

- The owner (2026-10-16): write the fix up as this proposal in Sheepfold, build the stopgap, and
  send the proposal to spacesheep once it is on the public repo. It goes public as the one file
  under `docs/` on the allowlist, and is then to be sent as an issue on
  `spacesheep-dev/spacesheep-cli`, the public repo nearest the page (the mirror lives there; the
  site's code is not public), linking this file.
