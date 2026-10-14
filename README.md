# WPBA Offline (mobile)

Offline-first workplace-based assessment app for anaesthesia training (Dire Dawa University prototype).
Everything runs **on the phone**: no server, no internet, no cloud. Data lives in the phone's IndexedDB.
Installable as a home-screen app (PWA) or built into an Android APK (Capacitor). Plain JavaScript, no build step, no runtime dependencies.

This supersedes the earlier Python/LAN-server prototype for day-to-day use (the Python code remains useful as a reference/analysis server).

## Get it onto phones

**Option A - PWA (fastest, no tooling).** Host the `www/` folder ONCE on any HTTPS static host (GitHub Pages, Netlify, a university
web server). On each phone, open the link in Chrome while online, then menu > *Install app* / *Add to Home screen*. After that
first visit the app works with no connection, forever. Updates are fetched automatically the next time the phone is online
(bump `VERSION` in `www/sw.js` when you change files).
Note: browsers only enable offline install on **HTTPS (or localhost)**; a plain `http://192.168.x.x` LAN address will not work for the PWA.

**Option B - Android APK (no hosting, install by file).** Needs Node, Java 17+ and Android Studio/SDK on one computer:

    npm run apk:setup     # installs Capacitor, creates android/ project
    npm run apk:open      # opens Android Studio -> Build > Build APK
    npm run apk:sync      # after any change inside www/

Copy the APK to phones by USB/Bluetooth/SHAREit and install (allow "unknown sources"). The APK was *not* built in my sandbox
(no Android SDK), so do one test install on a real phone before rolling out. In the Capacitor WebView, the share sheet / file
download for backups may behave differently from Chrome; if "Export backup" does not offer a save/share option, add
`@capacitor/filesystem` + `@capacitor/share` and call them from `saveFile()` in `www/app.js`.

**Option C - try it now:** `npm run serve`, open http://localhost:8080 (localhost counts as secure).

## Using it

1. First launch: create the administrator. Add faculty and residents (*Data > Add many residents* pastes a name list).
   "Load demo cohort" creates synthetic data (PIN 1234) for rehearsal.
2. Faculty: *New* - choose resident and tool, type observations (or use the keyboard's microphone key; Gboard offline
   dictation works with a downloaded language pack), tap **Suggest scores**, confirm/adjust the 1-5 entrustment buttons,
   tap **Draft feedback**, edit, **Save**. Purple buttons = AI-suggested, to be confirmed by the human.
3. Residents sign in to see their own milestone progress and feedback. Faculty/admin get *Residents* (per-person progress) and
   *Summary* (alerts, feedback delay, documentation time, % reduction vs your paper baseline).
4. **Back up weekly:** *Data > Export backup* creates an (optionally passphrase-encrypted, AES-GCM) `.wpba` file; send it to yourself or
   share it. On another phone, *Data > Import* **merges** it (people by id, assessments by uuid - add-only, never overwrites).
   This is how several faculty phones are consolidated into one programme view, without any network.
5. *Export CSV* gives one row per criterion score (incl. AI-suggested flag, feedback delay, documentation seconds) for the study analysis.

## What is on-device "AI" here, honestly

| Feature | Implementation | Notes |
|---|---|---|
| Note -> suggested rubric scores | Transparent keyword + supervision-cue engine (`core.js`) | Deterministic, auditable, zero download. Suggests only where a cue exists |
| Feedback drafting | Rule/template generator using scores, assessor note and the resident's longitudinal trend | Fast on any phone. Not a language model |
| Voice notes | Phone keyboard's offline dictation | Not bundled; check accuracy for your languages |
| Small language model | **Not included.** Would need WebGPU/WASM runtime + 0.5-2 GB model file; heavy for low-end phones | Natural next step: plug a quantised SLM into `draftFeedback()` behind the same interface and compare with templates in the study |

Provenance is stored per score (`ai`) and per narrative (`narrative_source`: faculty / ai_draft_accepted / ai_draft_edited) for validity analysis.

## Design traceability to the needs assessment

| Finding | Response |
|---|---|
| Zero internet dependency (consensus) | Service-worker shell + IndexedDB; no network call anywhere in the code |
| Paper folders lost | `navigator.storage.persist()`, backup nag after 7 days, encrypted export, merge-import |
| 87% delayed feedback | Feedback finalised at point of entry; delay measured (`feedback_ts - encounter_ts`) |
| 73% cannot track longitudinal milestones | 7 milestone domains, recent-vs-early trend, plain-language alerts, per-resident view |
| 18 min/week faculty archiving | No archiving step; programme summary generated on demand |
| Documentation fatigue | Tap-based entry, suggested scores, drafted feedback, `doc_seconds` measured per entry |
| Power cuts | Each save (data + audit entry) is one atomic IndexedDB transaction |

## Tests

    npm test                  # 8 logic tests (scoring, extraction, analytics, audit chain, crypto) in Node
    python3 test/e2e.py       # headless Chromium at phone size: setup, assess, go OFFLINE, reload, backup, restore (needs Playwright)

## Limitations to state in the paper / fix before real deployment

- **Security model is a PIN on a phone, not a vault.** Data in IndexedDB is not encrypted at rest; anyone with the unlocked device and
  technical skill can read it. Use the phone's screen lock/disk encryption. Backup files can be passphrase-encrypted. PINs are PBKDF2-hashed;
  the app auto-locks after 2 minutes in the background and delays after 5 wrong PINs.
- **Each phone holds its own copy.** Residents' phones will contain the resident list and any records merged onto them; for privacy, only
  import full backups on faculty/admin devices.
- **The audit chain is tamper-evident, not tamper-proof** (someone with full device access could rebuild it). It detects accidental or casual alteration.
- No automatic sync (by design, offline). Merging is manual via backup files.
- Rubrics in `www/core.js` are representative; replace with the exact criteria from the Dire Dawa folders.
- iPhone: PWAs work (Share > Add to Home Screen) but Safari may evict storage after ~7 days of non-use unless installed to the home screen; back up regularly.
- Needs ethics approval and data-protection review before real resident data is entered.
