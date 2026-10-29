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
  the destination folder. Native CLI fork support and an identifiable saved
  conversation are required. Sessions works fine without Companion.
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
