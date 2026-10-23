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
