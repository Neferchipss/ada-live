# Spike: linking one Ada conversation across terminal, Claude app (Remote Control) and Ada Live

Date: 2026-10-25. CLI under test: Claude Code 2.1.310, Windows 11. Investigation only; no repo code changed.
Legend: **[doc]** = stated in official docs, **[obs]** = observed in a throwaway test today, **[inf]** = my inference.

## 1. What the installed CLI exposes

- `claude --help`: `--remote-control [name]` "Start an interactive session with Remote Control enabled (optionally named)".
- `claude --help`: `--input-format <format>` "Input format (only works with --print): "text" (default), or "stream-json" (realtime streaming input)". Also `--replay-user-messages`, `--include-partial-messages`, `--session-id <uuid>`, `-r/--resume`, `-c/--continue`, `--fork-session`, `--bg/--background`, and subcommands `attach`, `logs`, `agents`, `stop`, `respawn`.
- `claude remote-control --help`: "Remote Control runs as a persistent server that accepts multiple concurrent sessions in the current directory". Flags: `--name`, `--session-id <id>` (reattach), `-c/--continue`, `--spawn same-dir|worktree|session`, `--capacity`, `--permission-mode`. Nothing about stdin/stream-json.
- In-session: `/remote-control` (alias `/rc`). Auto-connect: setting `remoteControlAtStartup`, or `/config` "Enable Remote Control for all sessions".
- `--channels` is not in `--help` (documented as hidden during research preview).

## 2. Docs read (URLs and what matters)

- https://code.claude.com/docs/en/remote-control
  - Three entry points: `claude remote-control` (server mode), `claude --remote-control` (full interactive TUI), `/remote-control` inside a session. **[doc]**
  - "you can send messages from your terminal, browser, and phone interchangeably", conversation "stays in sync across all connected devices". **[doc]**
  - "Claude keeps running locally"; the transcript is also stored on Anthropic servers for sync. **[doc]**
  - Limit: "One remote session per interactive process". Local process must keep running. **[doc]**
  - Resuming the conversation in a second terminal while the first has RC on: "Remote Control not started here" notice, RC stays with the first terminal. **[doc]**
  - `/resume` to another conversation: the phone does not get the history, but new messages go to whichever conversation is open in the terminal. **[doc]**
  - Server mode spawns sessions on demand (`--spawn`); how those child sessions run (TUI vs headless) is not documented. **[unknown]**
  - Nothing in the page says RC works with `-p` or stream-json.
- https://code.claude.com/docs/en/headless
  - `-p --resume <id>` and `--continue` are the documented per-message pattern. `--output-format stream-json` is documented; `--input-format stream-json` is only mentioned in passing (wakeups). Resume can be given a `.jsonl` transcript path. **[doc]**
- https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
  - Streaming input mode = "a long lived process that takes in user input", queued messages, interrupts. This is the supported way to keep one process alive and feed it messages. **[doc]**
- https://code.claude.com/docs/en/sessions
  - Transcripts: `~/.claude/projects/<project>/<session-id>.jsonl`; "The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release." **[doc]**
  - "If you resume the same session in two terminals without forking, messages from both interleave into one transcript." **[doc]**
  - `-p` sessions are hidden from the picker and `--continue` but resumable by ID. **[doc]**
  - Background sessions: `claude -p --resume <session> "prompt"` typed at a terminal on a session that is running in the background sends the prompt to it and attaches, instead of running headless. Refused under piped I/O, `--output-format`, `--permission-mode`, etc. (exit 1). **[doc]**
- https://code.claude.com/docs/en/agent-view
  - `claude --bg "prompt"` / `claude --resume <id> --bg`: a full interactive session hosted by a supervisor with no terminal; `claude attach <id>` opens it; `claude logs <id>` prints recent output; `claude agents --json` lists. "Two processes can't write to the same transcript" is quoted for a stopped session open in another live process. `--bg` cannot combine with `-p`. Research preview. (I read only the first ~100k chars of this page.) **[doc]**
  - Whether Remote Control can be switched on in a `--bg` session: not stated. **[unknown]**
- https://code.claude.com/docs/en/cross-session-messaging (v2.1.234+ on native Windows; we have 2.1.310)
  - Each session binds an inbox socket (named pipe on Windows); Claude can message other local sessions with `SendMessage`; "a long-running `-p` worker can receive messages and appears in the listing" (not in `--bare`). Idle session starts a new turn with the message; busy session reads it between tool calls. **[doc]**
  - "when you want a script or hook to post into a session" is listed as a reason to read the socket section, but the wire format beyond `{"type":"auth","token":...}` as first line is not documented, and the token/path are exported only to the session's own children (`CLAUDE_CODE_MESSAGING_SOCKET/TOKEN`). **[doc, partly]**
  - Inbound policy `crossSessionInbound` accept/hold/refuse; for `-p` workers set `accept` via `--settings`. Received text is "from another session, not from you": it cannot approve permission prompts. **[doc]**
  - **[obs]** Windows pipes `\\.\pipe\LOCAL\cc-msg-<hash>` exist for each live session, and `~/.claude/sessions/<pid>.json` holds per-process `peerToken` metadata. Not documented as an interface; I did not touch or test it.
- https://code.claude.com/docs/en/channels (research preview, hidden flag)
  - A channel is an MCP server declared with `--channels` that pushes events into a running interactive session; two-way (Claude replies via a tool). Needs claude.ai login; plugins must be on an Anthropic allowlist, or use `--dangerously-load-development-channels` for your own. Works in `-p` too. Custom channels: https://code.claude.com/docs/en/channels-reference (not read in full). **[doc]**

## 3. Answers

**(a) Can Remote Control run in a headless/stream-json process, or only the interactive TUI?**
Documented RC entry points are all interactive (TUI) or the `claude remote-control` server. Nothing documents RC combined with `-p`/`--input-format stream-json`. `--remote-control` is described as "Start an interactive session". Not tested end to end (would register a real session on Nefer's account). Closest headless-ish options: `claude --bg` (supervisor-hosted interactive session, no terminal) and RC server mode. Confidence that plain `-p` cannot be Remote Controlled: medium-high (absence in docs and help). Whether `--bg` + `/rc` works: unknown.

**(b) Supported way for another process to send a user message into a running interactive/remote-controlled session?**
Supported, documented routes:
1. Channels (MCP server pushed events): official, two-way, but research preview, hidden flag, allowlist/dev flag, and the message arrives as a `<channel>` event, not as a typed user message in the transcript sense. Needs a custom channel for Ada. Confidence: medium.
2. Cross-session messaging: another Claude session `SendMessage`s to it; arrives as "message from another session" and starts a turn when idle. A script needs the pipe protocol, which is undocumented. Confidence: medium that it works from a Claude-driven sender, low for a raw script.
3. `claude -p --resume <id> "prompt"` against a session that runs as a background session: documented to deliver into the running session (terminal-typed only; refused with pipes/flags). Not usable from a spawned collector with captured output.
4. `--input-format stream-json` into a process the collector owns: fully supported, but only for the process you spawned (not an arbitrary terminal).
No documented API to type into an arbitrary terminal TUI.

**(c) `claude -p --resume <id>` on a session open elsewhere**
Tested **[obs]** with a throwaway session in a temp dir: process P1 = `claude -p --input-format stream-json --resume <id>` kept alive and idle; while idle, process P2 = `claude -p --resume <id> "reply FOUR..."` ran concurrently. Result:
- No error, no lock, no refusal. Both succeeded and wrote to the same `<id>.jsonl` (same session ID, no new session).
- The transcript forked silently inside the one file: P2's user message parented to P1's last reply; later P1 turn "THREE" parented to the same earlier reply, not to P2's reply. P1's in-memory context never saw P2's turn. Real-world effect: each process continues from its own branch; whichever is resumed later picks one leaf.
- Not tested (cannot be automated safely): a real interactive TUI with `/remote-control`, and the mobile/web app view. Predicted from docs **[inf]**: terminal TUI keeps its own in-memory branch and will not display the `-p` turn live (stale view); the app, which mirrors what the interactive process sends to Anthropic, will not show the `-p` turn either; on later `--resume` the leaf choice is ambiguous. Confidence: medium on terminal, low on app. The docs only guarantee interleave into one transcript for two terminals.
- Documented counter-case: if the session is a live background session, `-p --resume` at a TTY goes to that session instead (see above).

**(d) Can the collector tail the transcript to mirror activity?**
Yes **[obs]**: `~/.claude/projects/<cwd-with-non-alnum→->/<session-id>.jsonl`, one JSON object per line, `type` in user / assistant / system / attachment / last-prompt / mode / cost-state / api-request(-blob) etc., each with `uuid`, `parentUuid`, `sessionId`, `timestamp`. The user line was written ~1.6 s after the stream-json send (before the model replied, i.e. at turn start); the assistant line landed <0.1 s after it appeared on stdout (my 100 ms poll resolution). So write latency is effectively immediate. Caveats: format is documented as internal and unstable; records form a tree via `parentUuid` (forks possible, see c) so the collector must follow one chain; many non-conversation record types and large `api-request-blob` entries must be filtered. Confidence: high that tailing works today, medium for long-term stability. Remote-control messages from the phone are expected to appear as ordinary user records in the same file **[inf]**, not verified.

## 4. Architecture options

**A. Ada = one long-lived interactive session with Remote Control (`claude --remote-control "Ada"` in a persistent terminal, e.g. tmux/ConPTY); Ada Live tails its transcript and writes via a channel.**
- Works: terminal and phone app are first-class, in sync by design [doc]. Ada Live shows everything by tailing the transcript [obs].
- Gap: Ada Live must *write* into the TUI. Options: custom channel MCP server (research preview, needs `--dangerously-load-development-channels` or allowlist, event shows as channel message), or cross-session pipe (undocumented protocol), or PTY keystroke injection (fragile).
- Failure modes: preview features change; permission prompts block the TUI until answered; the process must stay up (and exits on crash/reboot, RC "about four hours" re-attach window for server mode); one RC session per interactive process.
- Effort: medium-high (supervised persistent TUI on Windows, channel server, transcript tailer reuse). Confidence it can be built: medium. Confidence it stays stable: low-medium.

**B. Ada = persistent `claude -p --input-format stream-json` process owned by the collector; terminal/app attach somehow.**
- Works: Ada Live send/receive is clean and fully supported (queued messages, interrupts, no process spawn per message, preserves caches) [doc]. Mirroring needs no transcript parsing for Ada's own traffic.
- Gap: no documented way to attach RC or a terminal to that process. Terminal could `claude --resume <id>` but that forks (see c), so it would not be "one conversation". `--bg` session + `claude attach` is the closest "persistent but attachable" model but `--bg` cannot take `-p`/stream-json, so the collector would have to message it via cross-session pipe or `claude --resume <id> --bg`.
- Failure modes: forked transcripts as soon as anything else resumes the same ID.
- Effort: low-medium for the Ada Live part, high to get the other two clients. Confidence for Ada-only: high; for three-way linking: low.

**C. Keep headless per-message (`-p --resume`), add transcript mirroring.**
- Works today; terminal and phone could be *read* by tailing, and Ada Live messages arrive in the transcript. Cheapest.
- Gap: not live in the other clients: an open TUI/RC session does not pick up a `-p` turn (stale), and concurrent use forks silently [obs]. Mitigation is a convention: only one writer at a time, and the terminal/app side always does `claude --resume` fresh after Ada Live turns.
- Failure modes: fork when two clients send near-simultaneously; the phone app (real RC session) cannot see Ada Live turns.
- Effort: low. Confidence: high that it works as described; it does not meet the "like a Remote Control session" goal.

## 5. Recommendation

Start with **A, delivered in two steps**, and keep C as the fallback in the meantime:
1. Make Ada a single interactive session launched with `--remote-control "Ada"` in a supervised persistent terminal. This is the only option where the terminal and the phone app are the real Remote Control clients. Ada Live reads its transcript (already implemented, verified latency).
2. Spike the write path from Ada Live as a custom channel (research preview; doc'd as two-way) before committing. If the channel does not work reliably with Windows and allowlist rules, fall back to the cross-session inbox pipe with the documented auth line, and failing that C with a "one writer at a time" rule.
B is the best for Ada-only reliability but cannot satisfy the three-way requirement.

## 6. Unknown / not verified

- RC with a real interactive session: stale-view behavior of the TUI and the mobile app when a `-p --resume` turn is written to the same session (predicted, not observed; automation would need a TTY and would register a real RC session on Nefer's account).
- Whether a phone-sent RC message shows up in the local transcript as an ordinary user record, and its latency.
- Whether `claude --bg` sessions can enable Remote Control, and how RC server-mode child sessions run.
- Channels: whether a custom channel loads on Windows with a Pro/Max login, `--dangerously-load-development-channels` behavior, and how a channel message is recorded in the transcript. `channels-reference` not read in full.
- Cross-session pipe: the message wire format after the auth line, and whether an external (non-child) process is accepted under `crossSessionInbound` defaults.
- `agent-view` page read only partially (first ~100k of ~147k chars).
- Test side effects: a throwaway project dir under the OS temp folder was created and removed; it used only a trivial prompt, nothing of Ada's. Observation: the user's `SessionStart` hook ("ADA RE-ANCHOR") also ran in the throwaway session.
- Quirk seen in my harness: my node driver stopped logging after ~23 s and its claude child had to be killed manually (killed; no other leftover processes of mine).
