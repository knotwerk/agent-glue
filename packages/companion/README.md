# Agent Glue Companion

A side panel for working beside agent terminals in VS Code, including over
Remote SSH. Keep the native Claude and Codex CLIs while finding their files,
reviewing changes and following tasks across projects.

![Files, PRs and Tasks with synthetic example content](https://raw.githubusercontent.com/knotwerk/agent-glue/main/docs/images/agent-glue-sidebar.png)

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
- **Attachments**: drop files or paste screenshots (up to 25 MB each). They are
  stored in the Git-ignored `.local/agent-glue/inbox/` of the agent's project,
  and their paths are added to your draft.
- **Draft and dictation**: write a note (macOS Dictation works in the field),
  then **Copy** it or **Paste to agent**. Paste never presses Enter. The microphone
  sets up its bundled helper locally on the Mac through VS Code’s installer.
  macOS may ask for Accessibility or Automation permission. Drag the divider above Note to resize it against Recent Files.
- **Layout**: **Agent Glue: Toggle Right Sidebar Layout** moves the sidebar to
  the right and hides terminal tabs; run it again to restore your previous
  values.

Install **Agent Glue Sessions** as well to focus and paste into terminals; the
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

The header contains Files, PRs and Tasks.

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
you can choose the files again for the intended recipient.

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

## Tasks

Choose the checklist icon (**Agent Glue: Tasks**) to see reported work across
agents in the selected terminal's Git project. Unfinished tasks are shown first;
choose All tasks or Done to see completed work. Expand a row for its owner,
last update, summary and next step. Status is reported by the agent, not inferred
from running processes; check the update time when work looks stale. The visible
view refreshes about every six seconds, or use Refresh.

Click **Set up with agent** to paste a setup request into the selected terminal.
Press Enter to send. The request asks the agent to add the convention to the
project’s CLAUDE.md and AGENTS.md (or existing local instructions), preserve
existing rules, keep task records ignored locally, and record current work.
The button does not submit the prompt or edit project files itself. The command
**Agent Glue: Install Agent Instructions** remains available for direct setup.

Each agent maintains a separate JSON file in `.local/agent-glue/tasks/` at the
Git project root. Keep that local directory ignored. Required fields are `title`,
`status` (`active`, `blocked`, `review`, `done`) and `updatedAt` (ISO timestamp).
Optional `owner`, `summary`, and `next` give context. Use unique filenames and
atomic writes; update at milestones and mark done after verification. Records
are limited to 16 KiB each and 200 per project. Invalid records produce a warning
without hiding valid tasks. No conversations or agent memory are indexed.
