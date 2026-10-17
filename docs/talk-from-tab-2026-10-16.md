# Messages to a session from a VS Code tab — a proposal to spacesheep, 2026-10-16

Status: proposal, public 2026-10-16, revised the same day for VS Code 1.142's integrated browser
(section "VS Code 1.142"), sent as spacesheep-dev/spacesheep-cli issue 53; Sheepfold's stopgap
built (0.6.0, "Open in Browser").

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

## Proposal: approve the tab's key on another device, by code

The grant already separates the passkey from the key that signs. The key can be made anywhere;
only the assertion over the grant has to happen where the passkey is: spacesheep.dev in a real
browser, on this computer or a phone. So, in the shape of a device-code sign-in:

1. When the Session tab needs a grant and the passkey cannot be used where the page is — the
   page is not on the `rp_id` (the mirror), or the person picks "Approve on another device"
   (an embedded browser such as VS Code's, where no passkey is reachable; section "VS Code
   1.142") — the page makes its key pair as it does now (non-extractable, in its own IndexedDB)
   and builds the grant string with `rp: rp_id`.
2. It asks the server for an approval: `POST /api/grants/pending { grant }` (through the
   mirror, on the CLI's own signed-in session; or on the embedded browser's own) and gets back
   `{ code }`, short (eight characters), five minutes, one use.
3. It shows the code, "Approve at spacesheep.dev/approve", and a QR code of
   `https://${rp_id}/approve?code=${code}`. The page builds that URL itself, at run time: the
   mirror rewrites every `//spacesheep.dev` it finds in a page, script or JSON answer to its own
   `localhost` address, so a URL the server sent, or one written out in the script, would point
   at `localhost`, where the passkey cannot be used. (The bare `rp_id` survives the mirror for
   the same reason: no `//` in front.) No button that opens a window: in VS Code 1.142 a new
   window from the page opens as another VS Code browser tab, where the passkey is not
   reachable either; Sheepfold's "Open in Browser" (below) or the phone's camera is the way out.
4. The approve page, signed in as the same account, takes the code (typed, or filled from the
   QR), shows what it approves — the machine(s), "a browser tab", the expiry — and on a click
   runs the passkey assertion over the grant's hash, exactly as the Session tab does today. It
   posts the assertion to `POST /api/grants/pending/<code>`.
5. The page polls `GET /api/grants/pending/<code>` and, once the assertion is there, holds a
   grant it uses like any other until it expires.

Why this and not the alternatives:

- **No sessionpipe change.** The assertion's `clientData.origin` is `https://spacesheep.dev`
  and the grant's `rp` is the receiver's `rpId`, so `originAllowed` and `parseGrant` pass as
  they are; the daemon never sees where the grant's key lives.
- **Same trust as today.** A message still needs a passkey the owner enrolled at the terminal;
  the tab only borrows a 24-hour key approved by touching it, as a phone does.
- **One touch a day per tab origin**, not one per message.

Guards the approve flow needs:

- **The code is the guard.** The mirror lends the account's session to whatever reaches it,
  so anything that can call the mirror could file a pending approval for a key of its own, and
  the owner's touch on that code would grant that key. What stops it is that the owner brings
  the code from the tab they are looking at, typed or scanned, so the approve page never offers
  a code nobody asked for, and acts only on a click (a passkey prompt that appears unasked is
  easy to approve by reflex). A grant someone else collects is useless without the private key
  it names, so approving the right code is enough. This is the device-code pattern (RFC 8628)
  with a passkey at the end.
- The pending approval belongs to the account that created it: another account cannot read or
  complete it.
- This leans on the mirror answering only its own pages; the mirror findings sent privately on
  2026-10-11 bear on that and are worth closing first.

Rejected:

- **The mirror signs for the tab**, with a local key enrolled through the daemon's `key.add`:
  needs a non-passkey key type in sessionpipe, and makes every local process that can reach the
  mirror able to message every session.
- **spacesheep.dev straight in VS Code's integrated browser**, no mirror: the origin is right,
  but no passkey is reachable there (section "VS Code 1.142"), so it fails at the same step.
- **A passkey for `localhost`**: a second passkey per machine, a daemon change to accept a
  second `rpId`, and inside Simple Browser's frame (which sets no `publickey-credentials-get`
  permission) the daemon would refuse the assertion as `crossOrigin` anyway.

## VS Code 1.142: the integrated browser reaches no passkey

The mirror exists because spacesheep.dev refuses to be framed, and Simple Browser is a frame.
VS Code 1.142 sends `simpleBrowser.show` to its own integrated browser instead
(`workbench.action.browser.open`). Read from VS Code 1.142.0's main process (`mainImpl.js`),
its Electron 43.7.7 and its code signature:

- **It is a top-level view, not a frame**: an Electron `WebContentsView` in the window, with its
  own persistent storage (`persist:vscode-browser`, or a per-workspace folder). spacesheep.dev
  could load in it directly; the frame refusal no longer applies.
- **It reaches no passkey on macOS.** Passkeys in iCloud Keychain or a password manager reach
  an app only with Apple's managed entitlement
  `com.apple.developer.web-browser.public-key-credential`; VS Code is signed with four
  entitlements (Apple events, JIT, microphone, camera) and not that one. Electron 43 can offer
  Touch ID passkeys (`app.configureWebAuthn({ touchID })`, which needs a `keychain-access-groups`
  entitlement too), but VS Code never calls it, and that path reaches only passkeys made inside
  the app. So a passkey enrolled from a browser cannot sign on spacesheep.dev inside VS Code
  either, whatever the origin. Not tried: a USB security key, and a phone over Bluetooth
  (Chrome's QR-code prompt belongs to Chrome, not to Electron, so unlikely).
- **A new window opens inside VS Code.** The view's `setWindowOpenHandler` turns `window.open`
  and `target="_blank"` into another integrated-browser tab (when its popup permission allows),
  not the system browser, so the page cannot hand off to a real browser by itself.

What follows: the fix is needed for VS Code 1.142 as much as for the mirror, and its last step
has to happen on another device or browser, which is why step 3 shows a code and a QR rather
than a button. The mirror still earns its place in VS Code: it signs the page in with the CLI's
key, where the integrated browser's own storage would need a sign-in of its own (and Google may
refuse an embedded browser; not tried). Other editors (older VS Code, Cursor, VSCodium) keep
Simple Browser's frame and need the mirror for the page to load at all.

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
- The owner (2026-10-16): re-analyse the proposal on VS Code 1.142. Done above: the browser hand-off
  became a device code, and the open question about the integrated browser is answered from VS
  Code's own code rather than left for a hand test.
