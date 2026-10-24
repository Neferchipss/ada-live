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
