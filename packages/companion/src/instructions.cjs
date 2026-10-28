'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const marker='<!-- agent-glue-instructions-v1 -->';
const instructions=`${marker}
## Sharing documents with Agent Glue

Use project Markdown (.md, .markdown) or HTML (.html, .htm) files for documents
for the human to review. Create the file first, then print one marker and an
absolute path on its own line in the agent terminal:

- [share] /absolute/path/review.md — show a recent document.
- [pin] /absolute/path/review.md — keep a document above recents.
- [unpin] /absolute/path/review.md — return it to recents.
- [remove] /absolute/path/review.md — hide it from the panel; NEVER delete it.

Print only the marker and path, without the explanations above. Quote paths
containing spaces, for example: [pin] "/absolute/path/review notes.md".
Use pins for current review artifacts, not every intermediate file. Remove
superseded documents from the panel when appropriate. Removal affects this
terminal's list only. Use [share] or [pin] to bring a removed document back.
The human can add descriptions using the pencil beside a pinned document.

Agent Glue reads the last 2,000 terminal lines while this terminal is selected
and the sidebar is visible. If a marker was missed, print it again. It does
not execute shell commands or read conversation history. Markers are output,
not shell commands. Missing files are hidden. The list keeps 100 recents, showing 20 initially with Show more, plus
pins, and remembers up to 250 hidden entries. User actions take precedence
over repeated markers still in the same terminal output. To intentionally
repeat an identical directive after a user override, add a trailing unique
comment, e.g. [pin] /absolute/path/review.md # review-2.

For PR review, include the stable project/backlog code and a short topic, such as
"DEMO-UX-01: Preserve inspector selection". Compact local labels put the code first:
"DEMO-UX-03 · Preview drawer". Design choices use
"Decision: DEMO-UX-03 — Preview drawer" and remain draft while
discussed. Start with the recorded original backlog request and its provenance,
then explain the actual change/choice, alternatives, relevant visuals and checks.
List labelled repository-relative Markdown/HTML/image links under the exact
heading "## Review material" in the PR body. Agent Glue groups those links under
the PR beside its changed files. Before publishing, human feedback on prepared
reviews is stored in .local/agent-glue/review-comments.jsonl, keyed by reviewId
(local: plus the draft id) from .local/agent-glue/reviews.json. When asked to
review all PR comments, read that local feedback, inspect its linked material,
make the requested changes, and report the comment IDs addressed or needing
clarification. Preserve the feedback log; local feedback is not permission to
push or publish. Hosted PR discussion stays on GitHub. Update the
proposal's outcome after human review. Follow the repository contribution guide
for matched screenshots, publishing identity and approval requirements.
<!-- /agent-glue-instructions-v1 -->
`;
const taskMarker='<!-- agent-glue-tasks-v1 -->';
const taskInstructions=`${taskMarker}
## Track work in Agent Glue

Maintain one JSON file per substantive task at the Git project root:
.local/agent-glue/tasks/<unique-task-id>.json. Keep this local directory ignored
by Git. Use a unique descriptive filename; never overwrite another agent's task.
Create a record when starting work, update at milestones or when blocked, and
mark done only after verifying the requested outcome. Resume the same task file
when continuing work. No heartbeat is required. Use an atomic temporary-file
write and rename so readers never see partial JSON. Do not store secrets or
conversation transcripts. Do not delete other agents' records.

Example (replace the timestamp with the actual current UTC time):
{
  "title": "Fix image ordering",
  "status": "active",
  "owner": "claude-image-ordering",
  "summary": "Implementing file filters; browser checks remain.",
  "next": "Test in a narrow sidebar",
  "updatedAt": "2026-10-21T12:00:00Z"
}

Allowed status: active, blocked, review (waiting for human review), done.
Include a concise owner/session name, progress summary, next step or blocker,
and an ISO timestamp updatedAt on every change. Keep each file under 16 KiB.
Agent Glue shows up to 200 records for the selected terminal's Git project.
It displays reported progress, not proof that an agent is currently running.
${'<!-- /agent-glue-tasks-v1 -->'}
`;
async function install(root){
  const results=[];
  for(const name of ['AGENTS.md','CLAUDE.md']){
    const file=path.join(root,name);
    // Append only, and refuse symlinks rather than following instructions elsewhere.
    const handle=await fs.open(file,constants.O_RDWR|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o644);
    try{
      if(!(await handle.stat()).isFile())throw new Error(`${name} must be a regular file.`);
      const existing=await handle.readFile('utf8');
      const additions=[!existing.includes(marker)&&instructions,!existing.includes(taskMarker)&&taskInstructions].filter(Boolean);
      if(!additions.length){results.push(`${name}: already installed`);continue;}
      await handle.writeFile('\n\n'+additions.join('\n'));
      results.push(`${name}: added`);
    }finally{await handle.close();}
  }
  return results;
}
const taskSetupPrompt=`Set up Agent Glue task tracking for the project we are working in. Add the task convention below to this project's CLAUDE.md and AGENTS.md (or their existing local instruction mechanism), preserving all existing rules and avoiding duplicate sections. Keep .local/agent-glue/ ignored locally by Git; do not commit or push these setup changes. Then record your current substantive tasks, including progress, blockers and next steps, and maintain them as we work. Do not invent tasks or mark unfinished work done.\n\n${taskInstructions}`;
module.exports={instructions,taskInstructions,taskSetupPrompt,install};
