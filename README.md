# Ada Live

Read-only, password-encrypted viewer for what Ada (Claude), Codex and ChatGPT are doing on this laptop.

- `docs/` — the static page (GitHub Pages). Decrypts the feed in the browser; cannot run anything.
- `collector/collect.mjs` — reads Claude Code + Codex session logs, delegated tasks and `C:\Work`,
  encrypts a snapshot (PBKDF2-SHA256 600k → AES-256-GCM) into `docs/data/live.enc.json`.
- `tools/delegate.mjs` — hand a job to Codex and log it as a task.
- `tools/ada-task.mjs` — log any task manually (start / update / done / fail).

Local settings (never committed): `~/.ada-viewer/config.json` → `{ "password": "...", "workRoot": "C:\Work" }`.

Run locally:

    node collector/collect.mjs          # keeps the feed fresh every 10 s
    cd docs && python -m http.server 8787 --bind 127.0.0.1

## Media in the Ada chat

- Ada can show files on the phone: she ends a reply with an `<attach>[{"path","caption"}]</attach>` block
  (max 6; paths must be absolute and inside `C:\Work` or `~/.ada-viewer/inbox`; png/jpg/webp/gif, mp4/webm/mov,
  pdf, txt/md/json/csv). Images are shrunk to 1600 px, video is converted to 720p H.264 under 20 MB with ffmpeg,
  results are cached in `~/.ada-viewer/media-cache` (500 MB cap, oldest first).
- The phone's paperclip uploads up to 10 files of 25 MB each (images, video, pdf, text). Chunks are sealed with the
  page key and reassembled in `~/.ada-viewer/inbox`; Ada is told the paths (videos: up to 8 frames, plus a transcript
  if a local whisper with a cached model is installed). Limit: 10 files / 100 MB per 10 minutes.
- Bytes travel as sealed chunks over the relay, fetched on demand by id; the snapshot only carries small metadata.
  This needs the relay in `relay/` redeployed once (`cd relay && npx wrangler deploy`); until then the paperclip is
  disabled and nothing else changes.
- ffmpeg/ffprobe must be on PATH for video and for shrinking big images; without them video is refused with a message.

## Active work, conflict guard and change journal

- **Active-work map** (`activeMap` in the snapshot): per project folder, who is working there right now: terminal
  Claude/Codex sessions (same `working` status the session readers already compute; a `blocked` session counts for
  30 minutes), Ada chat jobs (running, queued, awaiting approval) and delegated tasks. Ada's own sessions are left
  out. The chat strip groups rows by project and shows the subfolder and a source label.
- **Conflict guard**: before a safe or full job starts, `ChatHub` looks for an active terminal session or task whose
  folder equals, contains or sits inside the job's folder. If there is one the job stays `queued` with a
  `holdReason`, is re-checked on every pump and collector tick, and starts by itself when clear. After 10 minutes
  a notice is posted in chat. **Run anyway** sends the sealed `override-hold` command, which only skips this check:
  full jobs still need their approval and PIN. Ops jobs are exempt. A session sitting at the Work root itself does
  not block anything.
- **Change journal** (`~/.ada-viewer/journal.json`, newest 400 entries, 30 days): on each git refresh, new commits,
  branch changes and uncommitted file *names* (never contents; secret-looking names are dropped), credited to the
  session or job that was working in that project, plus a line when a terminal session goes from working to idle.
  The last 50 show under Activity → Recent changes, and Ada gets a digest of what changed since her last turn.

### Proposed follow-up: Claude Code hooks (design note, not implemented)

Polling git and session logs can only guess who changed what and when. Claude Code hooks could report it directly:

- A `PostToolUse` hook (matcher `Edit|Write|MultiEdit`) and a `Stop` hook run a tiny script that appends one JSON line
  (`{t, cwd, session_id, event, tool, file}`; file *name* only) to `~/.ada-viewer/hook-events.jsonl` and exits at once.
- The collector tails that file each tick and turns it into journal entries: exact attribution (no 3-minute grace
  guess), accurate session start/stop times, and sub-second "a session is editing X" for the conflict guard instead of
  waiting for the log-based `working` status.
- Hooks live in the user's Claude Code settings, so installing them is Nefer's decision: ship the script under
  `tools/` plus the settings snippet to paste, and keep the collector working unchanged when the file is absent.
  The script must never read stdin payload fields beyond those names and must fail silent so it cannot slow or break a session.
