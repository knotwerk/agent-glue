# Agent Glue

Close your laptop without worrying about rebuilding your agent sessions tomorrow.

Agent Glue stays as close as possible to the intended Claude, Codex and VS Code
workflow. Keep the real CLIs, native terminals, account settings and updates.
Add only the small pieces that make everyday work less painful.

It is best used with **VS Code Remote SSH to an always-on server**: agents run in
tmux on the server while your laptop is just the interface. Close the laptop or
turn it off, then reconnect later. The server must stay running.

The extensions handle named terminal sessions, files across projects, lightweight
reviews, and getting notes and images into remote agents. The local helper brings
back clipboard-image attachment and Mac dictation where remote terminal workflows
make them awkward. No replacement agent runtime or central orchestration service.

![Agent Glue Files, PRs and Tasks views, with explanatory captions and synthetic demo data](docs/images/agent-glue-sidebar.png)

*Actual Companion sidebar rendering with invented data. The native VS Code
view toolbar is outside these panels.*

## Two extensions, two jobs

| Extension | What it does |
| --- | --- |
| **[Sessions](packages/sessions/README.md)** | Attaches named tmux sessions to native VS Code terminal tabs and reconnects them after disconnects or window reloads. |
| **[Companion](packages/companion/README.md)** | Adds the Agent Glue sidebar: Files, PRs, Tasks, and a note field with attachments and optional dictation. Follows the terminal you select, even outside the open workspace folder. |

Install either independently. Companion needs Sessions only to focus or paste
into an agent terminal. A bundled local helper supplies native downloads and,
on macOS, dictation and clipboard images.

## What gets easier

- **Come back tomorrow.** Sessions reconnects to agents you started in tmux.
  Your remote host must stay running: tmux survives closing the laptop, not
  rebooting the server. Agent Glue does not automatically wrap ordinary shells.
- **Find the file.** Paths mentioned in the selected terminal appear in Files.
  Recent mentions and edits sort newest-first. Filter by type or time, sort by
  name, and pin useful files. Open across projects without opening another
  VS Code window; right-click to download.
- **Read and review.** Preview Markdown, Mermaid diagrams, images and HTML.
  Review hosted PRs or prepared local changes. Keep stable ordering, mark items
  read, and leave local feedback before anything is pushed.
- **Keep track.** Tasks shows agent-reported progress, blockers and next steps.
  **Set up with agent** pastes instructions for maintaining small local task
  files. You press Enter; it does not submit automatically.
- **Send a clear note.** Write or dictate, attach a file or screenshot, then paste
  into the selected terminal. Check the recipient and press Enter yourself.

## Documents belong in the review

An agent's output is often a document, not just a code diff: a design proposal,
a comparison, a diagram or a small interactive HTML report. Agent Glue lets you
expand a PR's review material and open rendered `.md` or `.html` files immediately,
without hunting through the workspace or reading raw markup. Keep the explanation
beside the changes, then leave feedback for the agent.

![A PR file tree, rendered review and HTML comparison side by side, using synthetic content](docs/images/agent-glue-pr-review.png)

*Real Agent Glue webviews arranged for explanation. The project and document
content are invented. [How to prepare review material](docs/project-reviews.md).*

## Install from source

This is an **early release**, not a Marketplace installation. You build the VSIX
packages locally. MIT licensed; free to use, modify, redistribute and sell.

| Requirement | Where it is needed |
| --- | --- |
| VS Code 1.100+ with a trusted, non-virtual workspace | Your desktop / SSH window |
| Linux or macOS, `git`, `tmux` | Workspace host (remote machine for SSH) |
| `zsh`, `jq` | Workspace host, for Sessions |
| Node 22 and npm | Machine used to build the extensions |
| Claude or Codex CLI, installed and authenticated separately | Workspace host |
| GitHub CLI (`gh`), authenticated | Optional: hosted PR browsing and posting |
| macOS Dictation and Accessibility permission | Optional: local Mac dictation |

```sh
git clone https://github.com/knotwerk/agent-glue.git
cd agent-glue
npm ci
npm test
npm run check
npm run package
```

1. In VS Code, run **Extensions: Install from VSIX…** and select the Sessions and
   Companion packages under `dist/vsix/`.
2. In Remote SSH, install both on the **remote host**. The bundled helper belongs
   **locally** and is installed through Companion when needed. Reload the window.
3. Disable the old “Tmux Claude/Codex Attach” extension if you used it previously.
   It conflicts with Sessions.
4. Open the project on the workspace host and start your agent inside tmux:

   ```sh
   tmux new-session -s claude-my-project
   # In the new session:
   claude
   ```

   For Codex, use a session name such as `codex-my-project` and run `codex`.
5. Run **Agent Glue: Attach Agent Tmux Sessions**, select its terminal tab, then
   open **Agent Glue** in the activity bar. The view title offers Files, PRs and
   Tasks. Mention an existing file path to populate Files.

For attachments, local feedback and task records, ignore `.local/agent-glue/`
in the agent's Git project. Use the project's `.gitignore`, or add the pattern
to `.git/info/exclude` for a local-only choice. This does not untrack files that
were already committed.

## Multiple accounts and client subscriptions

Keep the personal account on `claude` / `codex` and give a client account its own
configuration directory. Add these functions to **the server’s** `~/.zshrc`:

```zsh
claude2() { CLAUDE_CONFIG_DIR="$HOME/.claude2" command claude "$@"; }
codex2()  { CODEX_HOME="$HOME/.codex2" command codex "$@"; }

# Reconnect to this named tmux session, or create it in the current directory.
alias client-claude='tmux new-session -A -s claude2-client -c "$PWD" zsh -ic claude2'
alias client-codex='tmux new-session -A -s codex2-client -c "$PWD" zsh -ic codex2'
```

Create the directories with `mkdir -p ~/.claude2 ~/.codex2`, restrict them with
`chmod 700 ~/.claude2 ~/.codex2`, and open a new terminal to load the functions.
For per-directory Codex credentials, add `cli_auth_credentials_store = "file"`
to `~/.codex2/config.toml`, preserving any existing settings. Run `codex2 login`
and `claude2` to sign in separately. Check the displayed account before working;
an inherited API key can select API billing instead of a subscription.

Then `cd` to the project and run `client-claude` or `client-codex` outside tmux.
For concurrent tasks, use distinct session names such as `claude2-client-docs`
and `claude2-client-tests`. Reusing a name reconnects its existing process.

Settings presets—Codex `--profile` and Claude `--settings`—are different from
account isolation. Follow the current [Codex configuration](https://developers.openai.com/codex/config-advanced/),
[Codex authentication](https://developers.openai.com/codex/auth/) and
[Claude authentication](https://code.claude.com/docs/en/authentication) guidance.
The Claude directory example is for claude.ai subscriptions; Console OAuth
profiles have different storage rules.

Live tmux sessions retain their account and environment. Agent Glue’s restart
helper recognizes `codex2`/`codex3`/`codexl` and `claude2`/`claudel`/`claudelp`,
each using the corresponding hidden directory under your home. Arbitrary custom
aliases and extra CLI flags need manual restart. Agent Glue does not add
permission-bypass flags or manage your credentials.

## Everyday controls

| View | Useful actions |
| --- | --- |
| Files | Click to open; right-click to download or copy the path. Recent ↓ uses mentions or edits; the small timestamp shows disk modification time. Show more expands 20 files at a time, up to 100 recents. |
| PRs | Click a name to open its review; expand the chevron for files. The right-hand dot marks read/unread; blue indicates new comments. **Leave comment** saves locally for prepared reviews, or posts to GitHub for hosted PRs. |
| Tasks | **Set up with agent**, then send the pasted request. Expand tasks for progress and update time. Status is maintained by agents, not inferred from running processes. |
| Note | Choose a recipient, attach files, and paste. The microphone and clipboard-image actions use the local Mac helper. |

Missing files? Check **All types / Any time**, use **Show all** if filters hide
files, or select **Refresh**. Only the selected pane's last 2,000 lines are
captured while the sidebar is visible. Mention the path again or use **Pin file**
if it has scrolled away. **Choose Session** handles an unmatched terminal.

## Limits and privacy

Agent Glue runs with the extension host's permissions. It does not index CLI
conversation histories or provide a sandbox for untrusted projects. Recent paths,
notes and selections persist in VS Code workspace state. Task and local review
records stay in the project's ignored local directory.

Native open/download actions use VS Code's connection. Optional **Open in browser**
links require a reachable ZeroTier network and act as temporary bearer links;
keep them private. See the [security model](docs/security.md).

Automated tests cover synthetic terminal responses, a fake VS Code host and
browser interactions. Native Mac gestures, remote attachment and editor placement
still need [manual acceptance](CONTRIBUTING.md#manual-acceptance) on your setup.

## More detail

[Companion guide](packages/companion/README.md) ·
[Sessions guide](packages/sessions/README.md) ·
[Mac helper](packages/mac-dictation/README.md) ·
[Project reviews](docs/project-reviews.md) ·
[Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE). Free to reuse and change, including commercially. Keep the license
and copyright notice with copies or substantial portions. No warranty is provided.
Bundled libraries and icons retain their own license notices.
