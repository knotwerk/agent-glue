# Reviewing project work

## Project reviews

Files / PRs and Refresh live in VS Code's native view header and follow the
selected terminal's project. Pin and Clear recent files are in the Files overflow
menu. The default is All PRs sorted by code/title, using natural numeric order.
The sort selector also offers PR number (descending), Updated (newest first),
and Priority. Opening a review does not reorder the list or mark it read.

Each review is one line: expand its chevron for files or click its name to open
the review. Hover the name for status details. Use the dot on the right to
**Mark read** or **Mark unread**; blue indicates new comments. Select **Unmarked** to work through the remaining reviews and
**All** to see everything again. Marks and sorting preferences survive
reloads; marks are scoped to the project and are independent of GitHub review
state and the new-comments indicator. New comments do not clear an explicit mark.

Use the Decisions PR filter for titles starting with `Decision:`; decisions
are draft PR discussions. There is no separate Decisions tab or feedback list.
Other filters include All, Open, Drafts, Merged, Closed, your review requests,
your waiting PRs and recent comments. Each hosted query is bounded to 30 results;
Priority combines recent, requested and waiting sets with all prepared packets.
Refresh runs on project/filter changes and once per minute while visible.

Expand a PR's Files into **Changes** and **Review material**. Changes are grouped
by directory and open a comparison of the recorded merge base and head; they
never substitute dirty checkout contents. Referenced Markdown/HTML and images
open in the main editor. Unavailable hosted files remain visible with GitHub
links. The main PR view includes the description, validated local screenshots,
conversation comments and review summaries. **Add a comment** posts Markdown
feedback to the opened PR using the signed-in GitHub CLI account. Local prepared
reviews instead save comments locally without contacting GitHub. Open in GitHub to inspect
inline review threads.

Declare attachments with a standard `## Review material` Markdown section in
the PR description. Use labelled repository-relative links, for example
`[Interactive mockup](docs/reviews/example.html#details)`. Links inside documents
are relative to those documents. The preview follows permitted Markdown, HTML,
image links and anchors inside its project root; external network content and
agent memory are excluded. Hosted attachments use a checkout at the exact PR
head when available; otherwise the viewer offers the revision-pinned GitHub link.

File-row browser/copy-link actions use a private ZeroTier preview server. Both
devices must be connected; links expire when the extension host closes/reloads.

## Prepared local PRs

Register unpublished packets in `.local/agent-glue/reviews.json` with
`{ "version": 1, "drafts": [...] }`. Linked worktrees fall back to the primary
checkout's index; their own index takes precedence. A draft has `id`, `title`,
`bodyFile`, and `artifacts`. An optional `label` gives the sidebar a compact
code and topic, for example `DEMO-UX-03 · Preview drawer`; `title` retains
the full `Decision: DEMO-UX-03 — Preview drawer` wording for the detail
view and Decisions filter. Missing or blank labels fall back to `title`. Optional `branch`, `worktree`, exact `base` and
`head` commit IDs provide the committed Changes tree. Documentation packets
without committed comparisons may declare proposed files as changes.

Artifacts have `path`, optional `label`, `href`, `anchor`, and `root` (this
repository or one of its registered worktrees). `group` is `review` by default
or `changes` for proposed scoped files. Include the body in the artifacts.
Each packet supports 100 artifacts and the index supports 50 packets. Existing
version-1 indexes remain compatible; legacy decision flags are no longer indexed
as a separate list.

Prepared packets are labelled **Prepared draft · not published**. Start a rich
body with the recorded original request and source revision, then explain the
change or choice, alternatives, relevant visuals, actual checks and feedback
needed. They do not imply hosted PRs or approval. Publish through the repository's
authorized contributor workflow and retire the corresponding local entry when
the hosted PR becomes available.

## Feedback before pushing

Open a prepared review, click **Leave comment**, and **Save local comment**.
Comments survive closing VS Code and appear when the review is reopened. The
review list shows a local-comment count. Ignore `.local/agent-glue/` in Git.

Feedback is appended to `.local/agent-glue/review-comments.jsonl` beside the
review index (including when a linked worktree uses the primary checkout’s
index). Each JSON line contains a version, unique comment `id`, `reviewId`
(`local:` plus the draft ID), title, backlog code, branch, body-file path,
reviewer label, timestamp and Markdown `body`. The index is not rewritten.
Comments stay associated with the stable draft ID when its title changes.
The log is capped at 4 MB and each comment at 60 KB.

**Review all local feedback** pastes a request with the index and feedback paths
into the selected agent terminal. Press Enter to send it. The request asks the
agent to make changes and report addressed comment IDs while preserving the
log; it does not authorize pushing or publishing. You can also ask the AI to
read these two files directly. Local comments are never automatically posted to
GitHub when a review is published.
