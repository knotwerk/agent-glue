# Security and privacy

Agent Glue is a trusted-workspace extension. It runs with the permissions of
the VS Code extension host and can read files on that host. It is not a sandbox
for an untrusted repository or agent process.

## Terminal and file discovery

Companion captures only the selected tmux pane while the sidebar is visible,
with a bounded 2,000-line capture. It never indexes CLI conversation histories.
Detected paths and notes persist in VS Code workspace state. Paths can refer to
other projects on the same host, independently of the open workspace folder.
Sessions retains bounded CLI session-metadata discovery for exact restoration.

Do not put credentials in terminal output or deliberately share sensitive files.
File discovery is a convenience, not a classification or secret-detection system.

## Previews and downloads

Markdown raw HTML is disabled. HTML previews run their own inline scripts in
an opaque-origin iframe, without extension APIs or parent-page access. CSP blocks
network subresources; interactive HTML is still active content and can navigate
its own frame. Render only documents you intend to open.

Embedded raster images and CSS must remain within the document's owning Git
project (or its directory outside Git), after symlink resolution. Documents
are capped at 25 MB, images at 5 MB each, and CSS at 1 MB, with a shared asset budget. This
project-root boundary does not by itself exclude every sensitive file inside a
project. Review-document links additionally exclude agent metadata directories.

Native downloads use the bundled UI helper to show a local Save dialog and copy
the selected file through VS Code’s filesystem API over the existing connection.
Cancellation writes nothing; the Save dialog handles replacement confirmation.

Browser previews bind to a private ZeroTier address. Random URLs
are bearer capabilities: anyone who receives a URL and can reach that address
can use it. They are HTTP links, not per-user authenticated sessions. Links last
until the extension host closes or reloads; individual links currently have no
expiry or revocation control.

## Attachments and notes

Uploads go to the target Git project's ignored `.local/agent-glue/inbox/` with
owner-only file permissions and random names. Symlink directories are refused.
Limits are 25 MB per file and four simultaneous transfers. Stalled transfers
expire after two minutes. Failed uploads can leave partial files; Agent Glue
does not delete inbox contents. Removing an attachment from a note leaves its
saved file in place. File contents are not scanned.

Paste uses bracketed paste and does not append Enter. An upload batch and native clipboard read hold their original recipient.
Check the recipient and attachment paths before sending, especially after
switching terminals once the transfer has completed. Mac
speech recognition is supplied by the operating system; the extension invokes
the native menu and does not implement its own audio capture service.

## Development and reporting

Use synthetic fixtures, injected tmux responses and a fake VS Code host during
development. Never test against an existing agent terminal or inspect real
conversation histories, credentials or memory directories.

Keep runtime output, inboxes, VSIXs and private screenshots out of Git. Package
checks enforce an allowlist and scan for common credential patterns. These are
heuristics, not a guarantee that a repository contains no private information.
Review the current files and Git history before changing repository visibility.

Report suspected vulnerabilities privately to the repository maintainer before
posting details publicly. Include versions and a synthetic reproduction; omit
credentials, private conversations and usable download links.

## PR comments

Posting requires the explicit **Post comment** action in a hosted PR view.
The host fixes the target to that opened PR, validates the body, and passes it
to `gh pr comment` over standard input, never through a shell. In-flight posts
are locked against double clicks. Failed requests retain the draft and are not
automatically retried because a network failure can leave the result uncertain.

Prepared local reviews use **Save local comment** instead. Feedback is appended
inside the review index’s project to an ignored JSONL log, with regular-directory
and no-symlink checks on writes. It is not posted to GitHub. The host chooses the
review identity and storage root; webview messages supply only comment text.
The **Review all local feedback** action pastes paths and instructions into the
selected agent terminal without submitting them. Existing local feedback is
shown when reviews reopen, independent of VS Code’s window state.

## Task records and restoration

Task records are read only from the selected project's local tasks directory,
with symlink checks and limits of 200 records and 16 KiB per record. Task text is
rendered as text, not executable HTML. Task status is reported by the agent and
can be stale. Setup pastes a request into the selected terminal without Enter.

Session restoration uses the CLI's configured permission policy. It does not
add permission-bypass flags. A live tmux session retains its original environment;
restarting a stopped process may not reproduce custom launch flags. See the
[account setup](../README.md#multiple-accounts-and-client-subscriptions) for supported account directory conventions.
