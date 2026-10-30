# Agent Glue Sessions

Close your laptop and reconnect to your Claude and Codex terminals tomorrow.
Best used with VS Code Remote SSH to an always-on Linux or Mac host.
The server must stay running; tmux does not survive a server reboot.

Claude and Codex tmux terminal integration for VS Code. It attaches
VS Code terminals to existing `claude*` and `codex*` tmux sessions, keeps their
titles, reconnects live sessions after a reload, and generates attach/restore
tasks.

**Early preview.** Requires VS Code 1.100+, a trusted workspace, and the agent
CLIs installed and authenticated separately. Install this extension on the SSH
host, start your agent inside a named tmux session such as `claude-my-project`
or `codex-my-project`, then run the attach command. Ordinary shells are not
automatically moved into tmux.

[Setup, multiple accounts and screenshots](https://github.com/knotwerk/agent-glue#readme).
MIT licensed, free to reuse and modify.

- Command: **Agent Glue: Attach Agent Tmux Sessions** (`tmuxClaude.attachAll`).
- Runs on the workspace host (Remote SSH installs it on the remote machine) and
  needs `tmux`, `zsh` and `jq` there.
- Generated tasks live in extension storage and appear through a task provider;
  workspace `tasks.json` is never touched.
- Exposes a small API to **Agent Glue Companion** (find, focus and paste into a
  session's terminal, and fork a saved conversation). With Companion installed,
  right-click a terminal tab → **Agent Glue: Fork Conversation** and confirm
  the destination folder, then choose a CLI/account. The same account uses a
  native conversation fork and requires an identifiable saved conversation.
  A different account starts a fresh conversation with a private handoff note
  containing source metadata, saved task status and optional pasted `/status`
  details. The note includes the known profile mappings and points to `~/.zshrc`
  for custom mappings; shell startup files are not read or sourced. Handoff notes
  stay in extension storage with owner-only file permissions. The new CLI receives
  a request to read the note, acknowledge it and wait; this initial response may
  use tokens. Login, model and MCP details are only included if you supply them,
  and describe the source account. Agent Glue does not read credentials or copy
  full chat histories.
  Supported profiles use the documented configuration-directory conventions;
  arbitrary aliases still require manual setup. Sessions works without Companion.
- Does not support untrusted or virtual workspaces.

If the original "Tmux Claude/Codex Attach" extension is installed, disable it
before enabling this one; Sessions warns and stays inactive otherwise.

Part of Agent Glue. Packaged and installed independently of Companion.

New tmux sessions get a ten-second startup grace period before automatic
attachment, so their launching terminal has time to register as a client.
Detached sessions are picked up on the next five-second poll after that grace
period; older sessions still attach immediately. Pending attachments retain
tmux's server/session identity across renames, rather than relying on the
terminal's temporary title. Distinct sessions may legitimately share a title.

Sessions never closes or recreates a terminal just to update its title. A tab
with a fixed startup label may keep that label after a tmux-side rename; use
VS Code's Rename Terminal action if needed. Its session mapping follows the
stable tmux identity, so the running terminal is preserved.

If an unmapped terminal already has the session’s title, automatic attachment
waits for that launcher even beyond the startup grace period. The title is only
a reason to wait, never proof of session identity. If an unrelated shell has
the same name, use **Agent Glue: Attach Agent Tmux Sessions** to attach explicitly.

## Python environment relaunch warnings

Agent Glue's newly attached and forked terminal clients use a fixed copy of the
extension host's launcher environment (`strictEnv`). They attach to an existing
tmux session; Python environment injection belongs inside the project shell,
not in that attach client. This prevents other extensions from contributing
new environment variables to these clients or requesting an environment refresh.
Normal terminals and the running agents' environments are unaffected.

An older tab may still show “extensions want to relaunch the terminal”, naming
Python. This is an environment-change notification, not an agent crash. The
new launcher policy cannot be applied retroactively to that existing process.
Agent Glue never restarts a running terminal to clear this warning. VS Code
already excludes extension-owned terminals from its automatic environment-change
relaunch path; the warning's Relaunch button is a separate manual action.
