# Agent Glue Companion

A side panel for working beside agent terminals in VS Code, including over
Remote SSH. Keep the native Claude and Codex CLIs while finding their files,
reviewing changes and following the selected terminal’s work.

![Files, PRs and Tasks with synthetic example content](https://raw.githubusercontent.com/knotwerk/agent-glue/main/docs/images/agent-glue-sidebar.png)

The screenshot includes the earlier Tasks view, now replaced by per-terminal Status.

**Early preview.** Requires VS Code 1.100+ and a trusted Linux or macOS workspace
host with `tmux` and `git`. Install on the SSH host. The bundled helper installs
locally for native downloads and optional Mac dictation and clipboard images.
See the [setup guide](https://github.com/knotwerk/agent-glue#readme).

- **Recent Files** view: follows the selected terminal and shows recently mentioned files,
  including plain Python, CSV and image paths relative to that terminal’s folder. Use `[pin] /path/to/file.md` in terminal
  output, or **Agent Glue: Pin File**, to keep a file at the top.
- **Preview**: renders `.md`, `.markdown`, `.html` and `.htm` in a sandboxed
  panel. Mermaid diagrams render in Markdown. Project-local document links and anchors work; remote content is
  blocked, and only project-local PNG/JPEG/GIF/WebP images (up to 5 MB) appear.
- **Fork Conversation**: right-click a terminal tab, then confirm or browse to
  its destination folder and choose a CLI/account. **Same CLI / account** uses
  native fork support and requires an identifiable saved conversation. Choosing
  another supported account starts a fresh chat with source metadata, profile
  mappings and saved task status. Optionally paste `/status` output or a short
  handoff note. Escape cancels; blank Enter skips the optional note. Requires
  Sessions. The original stays running; project files and chat histories are not
  copied between accounts.
- **Web apps**: a single collapsed line above Files shows active counts for
  this terminal and all terminals. Expand to see filenames or page paths beside
  links; use **All** for the cross-terminal list. Links use VS Code SSH forwarding. Right-click for browser
  and copy-link actions.
- **Attachments**: drop files (including HTML), paste screenshots, or paste
  absolute local file paths into the note (up to 200 MB per file upload). Path-only
  drops and pasted paths use the local helper to copy files to the SSH host.
  Quoted paths with spaces and file URLs are supported. Markdown and HTML previews also support files up to 200 MB.
  Clipboard images retain a separate 25 MB limit. They are
  stored in the Git-ignored `.local/agent-glue/inbox/` of the agent's project,
  and their paths are added to your draft.
- **Draft and dictation**: write a note (macOS Dictation works in the field),
  then **Copy** it or **Paste to agent**. Paste never presses Enter. The microphone
  sets up its bundled helper locally on the Mac through VS Code’s installer.
  macOS may ask for Accessibility or Automation permission. Drag the divider above Note to resize it against Recent Files.
- **Layout**: **Agent Glue: Toggle Right Sidebar Layout** moves the sidebar to
  the right and hides terminal tabs; run it again to restore your previous
  values.

Install **Agent Glue Sessions** as well to focus or paste into terminals and fork conversations; the
view, previews and Copy work without it. Requires `tmux` and `git` on the
workspace host. It captures only the selected pane, and only while the view is
visible. Companion never reads agent conversation histories.

Does not support untrusted or virtual workspaces. Part of Agent Glue; packaged
and installed independently of Sessions.

## Instructions for coding agents

Run **Agent Glue: Install Agent Instructions** in a trusted workspace to append
usage instructions to its `AGENTS.md` and `CLAUDE.md`. Existing rules are preserved;
repeat runs do not duplicate the section. Symlink instruction files are refused.
Agents already running may need to reread those files.

Print one marker and an absolute document path per line: `[share]`, `[pin]`,
`[unpin]`, or `[remove]`. Removal hides an entry from this terminal's panel and
never deletes the document. `[share]` or `[pin]` restores it. Quote paths with
spaces. Discovery runs only for the selected terminal while the sidebar is
visible and uses its last 2,000 lines. Repeated markers are idempotent; a trailing
unique comment can distinguish an intentional new directive after a user override.

Dictation shortcuts: double-tap Caps Lock within 500 ms while the note has focus,
or use Ctrl+Option+D anywhere in VS Code on Mac (Ctrl+Alt+D elsewhere).
The Caps Lock gesture is limited to the note field; it does not remap the system key.

Click Markdown/HTML files for a sandboxed preview; other files open in VS Code.
Right-click a file row for Open, Download or Copy path. Downloads use VS Code’s native Save dialog on your computer and transfer the
original bytes over the existing VS Code connection. The bundled local helper
is installed or updated when needed; reload if prompted. ZeroTier is only
needed for Open in browser and Copy browser link. Files can live outside the current VS Code workspace. No pin/share
marker is required for discovery, and missing paths do not consume recent slots.

File rows use bundled [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme)
SVGs (MIT; attribution and license in `media/material-license.txt`). Filenames wrap
across the available width, with the last two parent folders below. Hover or
keyboard-focus a row to reveal its action toolbar on a separate line; right-click
still opens file actions. Icons and controls work offline without another extension.

Recent files retain up to 100 entries per session and initially show 20. Use
**Show more** for another 20, or **Show fewer** to collapse. Pins remain visible
and do not count toward either limit. Switching sessions resets the view to 20.

## PR review material

The title follows the selected CLI, such as `AG - claude2` or `AG - codexl`.
The header contains Files, PRs, Status (pulse icon), and Refresh.


![PR review and rendered HTML with synthetic content](https://raw.githubusercontent.com/knotwerk/agent-glue/main/docs/images/agent-glue-pr-review.png)

Use `Decision: Topic — short description`
for proposal PRs, and the Decisions PR filter to find them. Expand a PR into
Changes (revision comparisons by directory) and Review material (notes, HTML
galleries and screenshots). Put labelled links under `## Review material`
in the PR body. Begin the description with the recorded original request and
include comparable screenshots where applicable. Use **Add a comment** in the PR detail view to post Markdown feedback to GitHub.
Posting uses the GitHub CLI account on the workspace host. Draft text stays in
the view after a failure; check GitHub before retrying an uncertain result.
Inline review threads and formal approvals remain on GitHub.

Terminal selection survives opening an editor. If the Sessions mapping is not
ready, Companion can match a unique exact terminal title to a live agent session;
ambiguous names are never guessed. Relative file references try the pane folder
first and the Git project root second. Opening documents, review attachments and
diffs explicitly focuses the first/main editor group. Unchanged polling updates
preserve the file rows and keyboard focus.

See [the repository guide](https://github.com/knotwerk/agent-glue) for setup and project-review details.

## License

MIT; see LICENSE.txt. Bundled libraries and Material icons retain their own notices.


## Session and upload recovery

At the top of a PR preview, **Discuss with agent** focuses the currently selected
agent terminal and pastes the PR title and GitHub URL, or the review-file path for
a local draft. Continue typing your question, then press Enter yourself. The
button preserves the note and attachments and never submits the terminal input.

If a terminal title cannot be matched, use **Agent Glue: Choose Session** from
the command palette or the view's overflow menu. This selects the file source
explicitly, including without Sessions installed. Selecting another native
terminal resumes automatic following.

A multi-file upload holds its original recipient until the batch completes.
Switching terminals can change the file list during transfer, but not the
upload destination. Failed transfers cancel their host upload; partial inbox
files remain. A queued batch whose recipient has already changed is refused so
you can choose the files again for the intended recipient. Project discovery is
retried if the destination was not ready yet; an existing filename does not cause
a recipient-change error. Uploads require a Git project with an ignored inbox.
A missing project or closed session is reported separately from a changed recipient.

Prepared reviews also support **Leave comment → Save local comment** before any
push. Feedback lives in `.local/agent-glue/review-comments.jsonl` beside the
review index. **Review all local feedback** pastes instructions into the selected
agent terminal; press Enter to send. This neither publishes the review nor posts
the comments to GitHub.

The PR list defaults to stable **Code** order. Use its sort selector for
PR number, updated time or priority. Mark rows read with the dot,
then choose **Unmarked** to work through the remainder. Opening a review
does not mark it read; your explicit marks and preferences survive reloads.

The Files toolbar filters by type (including images), modification time (last
hour, 24 hours or week), and sorts by latest terminal mention or modification (newest first), or natural filename
order. Combine Images, Last hour and Name for a batch of generated images.
Pins stay first and follow the same filters. Filters are remembered separately
for each terminal session. A hidden-file count and Show all button appear when
filters exclude discovered files. The controls apply to discovered
files, not a scan of the project; up to 100 recent files are retained.

## Terminal status

Choose **Terminal Status** (pulse icon) in the sidebar toolbar to see what the selected
terminal is working on: the original user request, progress, blockers, affected
files, and reported subagent activity. The default list keeps all unfinished
work plus the three most recently completed tasks. Robot refreshes update matching
tasks and append newly discovered work; tasks missing from the latest terminal
output remain in the list. Unfinished rows keep their order. Each row starts collapsed with a status icon, short title, state
and update age. Expand it to read the full title, a clear progress summary and
what happens next. Summaries use short, self-contained plain English; progress
is limited to 280 characters and the next step to 140 before a Read full control.
Files, other agents, the original request and technical update details stay
behind expandable sections. Reports are snapshots, not live monitoring.

**🤖 Run** starts a separate, non-interactive Claude or Codex CLI call using the
selected terminal’s account. It summarizes the last 500 recent terminal lines
(up to 24,000 characters), together with the saved task list; it does not resume or send input into the active chat,
index history, or edit project files. Missing context is reported as unknown.
The call uses tokens, and its usage is labelled separately from original-task
usage. A recent CLI version is required for isolated execution. Normal Refresh
only reads saved reports and uses no tokens. Reports persist in VS Code workspace
state; the panel remains usable while the robot runs.

Existing agent-maintained records remain supported. For an ongoing convention,
**Agent Glue: Install Agent Instructions** remains available.

Agents write ignored JSON records under `.local/agent-glue/tasks/` at the Git
project root, using a unique filename per terminal and user request. Fields:
`title`, `status` (`active`, `blocked`, `review`, `done`), `sessionId`, `owner`,
`request`, `summary`, `next`, `updatedAt` (UTC ISO timestamp). `sessionId` is the
tmux identity `#{pid}:#{session_id}:#{session_created}`; `owner` is its session name.
Old records without an identity match only an exact owner/session name.
Optional `files` and `agents` are lists of short strings; `tokens` is an exact
per-request integer count, omitted when unavailable. Never estimate token usage
or substitute a whole-session total. Use atomic writes, at most 16 KiB per record
and 200 records per project. No conversation histories or agent memory are indexed.

## Live terminal status

The **Terminals** selector displays local lifecycle events from Claude and Codex:
consistent RAG dots: amber for working, red for permission/input requested, green
for a finished turn, and grey for idle or unknown. Rows include plain-English status
and elapsed/update age. Hidden VS Code tool terminals are
excluded from the list.
Green means the agent finished responding, not that all project work is complete.
A permission indicator clears on the next recorded tool/prompt/completion event;
it can remain red while an approved long-running tool finishes. A working/waiting event older
than 15 minutes becomes unknown. A confirmed finished turn stays green with its
update age until another event arrives; idle remains idle.

Run **Agent Glue: Enable Live Terminal Status** once to install observer hooks in
existing standard account directories (`.claude`, `.claude2`, `.claudel`,
`.claudelp`, `.codex`, `.codex2`, `.codex3`, `.codexl`). Existing settings/hooks
are preserved and backed up privately. Custom config-directory mappings require
manual setup. Codex requires review/trust through `/hooks`; Agent Glue never
bypasses hook trust. Existing CLI sessions may need to reload their hook
configuration. No terminal is restarted automatically.

The observer only stores event names, timestamps, session IDs and tmux identity
under Companion's global storage. It discards prompt text, tool payloads and
transcript paths and does not read CLI history. Each pane has fixed event slots.
Background status works while Terminals is visible, using a three-second local
metadata refresh. Missing hooks show unknown; subagent events are not used to
invent a live helper count. No status update makes an AI call.

## Terminal selector layout prototype

Run **Agent Glue: Try Terminal Selector Beside Terminals** (also available as a
list button in the Terminal toolbar). This moves a compact selector into the
Terminal view container. With the panel at the bottom, VS Code lays its views out
side by side; a side-positioned panel stacks them instead. Adjust the divider to
try the layout. Clicking a name focuses that exact existing native terminal.
Terminal names and running processes are unchanged, and the built-in tab list
remains available. The selector follows open/close/selection events without
polling or reading terminal output.

Lifecycle indicators and elapsed minutes use the observer hooks described above. Helper counts are not yet shown. The view is titled **Terminals**; ordinary shells keep neutral terminal icons and agents show lifecycle indicators; the selection highlight identifies the active terminal. Placement uses VS Code's
workbench `vscode.moveViews` command and needs desktop acceptance testing. Use
**Agent Glue: Move Terminal Selector Back** to return it to its separate panel;
the selector view can also be hidden through its view menu.

The **Terminals** list supports hover actions for Fork Conversation (on mapped agent sessions) and Split (a new shell beside the
chosen terminal). It deliberately has no Close action. Drag rows to reorder;
the order is saved per workspace using tmux session names where known. Ordinary
shells use their name, starting folder and location; indistinguishable shells
can only be matched by occurrence after a reload. Duplicate names are labelled
Tab 1/Tab 2, and editor terminals are identified where VS Code exposes their
location. The selector includes editor terminals as well as panel terminals.

When this selector is visible, `terminal.integrated.tabs.enabled` is set to false.
The previous value and scope are remembered; **Move Terminal Selector Back** restores
it unless you have changed the setting yourself. This only affects terminal UI.
