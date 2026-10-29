# Agent Glue

Read README.md and CONTRIBUTING.md. Keep Sessions and Companion independently
packageable. Use Node 22 and npm. Run `npm test`, `npm run check`, and
`npm run package` before delivering a release.

Never interact with existing agent terminals during tests. Use injected tmux
responses and a fake VS Code host. Do not install or replace the user's active
extension until compatibility and host checks have passed. Never inspect real CLI
conversation histories, credentials, or memory directories during development.
The runtime may preserve existing bounded session-metadata discovery needed for
exact-session restoration; Companion never indexes conversation history files.
Capture only the selected pane when the companion view is visible.

Do not delete files or terminate existing processes. Keep runtime output, screenshots of private
conversations, inbox contents, credentials, and VSIXs out of git.

Publish only after inspecting the staged files for private material. Work in
the standalone repository on a dev branch; keep changes scoped to this repository.
Do not push or merge to main without the user’s explicit approval. Let dev changes
be exercised for about a week before proposing promotion; elapsed time alone is
not approval.
