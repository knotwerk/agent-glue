'use strict';

function attribute(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

const icons = {
  files: '<path d="M4 2h5l3 3v9H4zM9 2v4h3M6 9h4M6 11h4"/>',
  prs: '<circle cx="4" cy="3" r="2"/><circle cx="4" cy="13" r="2"/><circle cx="12" cy="13" r="2"/><path d="M4 5v6M12 11V6a3 3 0 0 0-3-3H8m2-2L8 3l2 2"/>',
  image: '<rect x="2" y="2" width="12" height="12" rx="1"/><path d="m3 12 4-5 3 3 2-2 2 4M10 5h.01"/>',
  attach: '<path d="m6 10 5-5a2 2 0 0 0-3-3L2 8a4 4 0 0 0 6 6l5-5M5 9l5-5"/>',
  clear: '<path d="m4 4 8 8M12 4l-8 8"/>',
  paste: '<path d="M5 3H3v11h10V3h-2M6 2h4v3H6zM6 8h4M6 11h4"/>',
  refresh: '<path d="M13 5a5.5 5.5 0 1 0 .5 5M13 2v3H10"/>',
  mic: '<rect x="6" y="2" width="4" height="7" rx="2"/><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2M5.5 14h5"/>',
  expand: '<path d="M10 2h4v4M14 2 9 7M6 14H2v-4M2 14l5-5"/>',
  add: '<path d="M8 3v10M3 8h10"/>',
  layout: '<rect x="2" y="2" width="12" height="12" rx="1"/><path d="M10 2v12M10 7h4"/>',
  copy: '<rect x="6" y="6" width="7" height="8" rx="1"/><path d="M10 4V2H2v8h2"/>',
};

function icon(name) {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || ''}</svg>`;
}

function button(id, title, glyph) {
  return `<button class="icon-button" id="${id}" type="button" title="${attribute(title)}" aria-label="${attribute(title)}">${icon(glyph)}</button>`;
}

function render({ nonce, scriptUri, styleUri, cspSource }, draftOnly) {
  const policy = `default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'; img-src ${cspSource} data:; font-src ${cspSource}; connect-src 'none'; form-action 'none'; base-uri 'none';`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${attribute(policy)}">
<title>${draftOnly ? 'Agent Glue — Draft' : 'Agent Glue'}</title>
<link rel="stylesheet" href="${attribute(styleUri)}"></head>
<body data-view="${draftOnly ? 'draft' : 'sidebar'}">
<main id="companion">
${draftOnly ? '' : `<section class="files section" aria-labelledby="files-title">
<h2 id="files-title" class="sr-only">Project resources</h2>
<header id="resource-controls" class="section-header" hidden><select id="pr-filter" aria-label="Filter pull requests" title="Filter pull requests" hidden><option value="priority">Priority</option><option value="all">All PRs</option><option value="open">Open</option><option value="drafts">Drafts</option><option value="decisions">Decisions</option><option value="review">Review requested</option><option value="mine">Mine awaiting review</option><option value="comments">Recent comments</option><option value="merged">Merged</option><option value="closed">Closed</option></select><select id="pr-sort" aria-label="Sort pull requests" title="Sort pull requests"><option value="title">Code</option><option value="number">PR number ↓</option><option value="updated">Updated ↓</option><option value="priority">Priority</option></select><select id="pr-read-filter" aria-label="Read status" title="Read status"><option value="all">All</option><option value="unread">Unmarked</option></select><span id="file-count" class="count"></span></header>
<div id="web-apps"></div><header id="file-controls" class="section-header"><select id="file-type" aria-label="File type" title="File type"><option value="all">All types</option><option value="images">Images</option><option value="documents">Documents</option><option value="code">Code</option><option value="data">Data</option><option value="archives">Archives</option><option value="other">Other</option></select><select id="file-age" aria-label="Modified within" title="File modification time"><option value="all">Any time</option><option value="1">Last hour</option><option value="24">Last 24h</option><option value="168">Last week</option></select><select id="file-sort" aria-label="Sort files" title="Sort files"><option value="recent">Recent ↓</option><option value="name">Name</option></select></header>
<header id="task-controls" class="section-header" hidden><select id="task-filter" aria-label="Filter tasks"><option value="active">Unfinished</option><option value="all">All tasks</option><option value="done">Done</option></select><button id="task-instructions" class="text-button" title="Paste a request to set up local task instructions into the selected agent terminal. Press Enter to send.">Set up with agent</button></header>
<div id="file-filter-notice" class="filter-notice" hidden><span id="file-filter-count"></span><button id="file-show-all" class="text-button">Show all</button></div>
<div id="files" class="list" role="list" aria-label="Pinned and recent files"></div>
<p id="files-empty" class="empty">Files mentioned by this agent appear here. Use <code>[pin] /path/to/file.md</code> to keep a document at the top.</p>
</section>`}
${draftOnly ? '' : '<div id="composer-resize" class="composer-resize" role="separator" aria-label="Resize notes and recent files" aria-orientation="horizontal" aria-valuemin="72" aria-valuemax="600" aria-valuenow="92" tabindex="0"></div>'}
<section class="compose section" aria-labelledby="compose-title">
<header class="section-header compose-header"><h2 id="compose-title">${draftOnly ? 'Draft' : 'Note'}</h2>
<select id="target" aria-label="Draft recipient" title="Draft recipient follows the selected terminal"><option value="">Select agent</option></select>
<div class="tools">
${button('choose-files', 'Attach files', 'attach')}
${button('dictate', 'Start Dictation — double-tap Caps Lock in the note, or Ctrl+Option+D', 'mic')}
${draftOnly ? '' : button('open-draft', 'Open a larger draft', 'expand')}
</div></header>
<input id="file-input" type="file" multiple hidden aria-label="Choose files">
<div id="drop-zone" class="drop-zone" role="group" aria-label="Note and attachments">
<div class="note-input">
<label class="sr-only" for="draft-text">Note for the agent</label>
<textarea id="draft-text" spellcheck="true" placeholder="Write, drop files, paste a screenshot, or use your Mac’s Dictation shortcut…"></textarea>
<div class="compose-actions" role="group" aria-label="Note actions">
${button('paste-image', 'Attach image from Mac clipboard', 'image')}
${button('clear-text', 'Clear text; keep attachments', 'clear')}
${button('copy-draft', 'Copy note', 'copy')}
<button id="paste-draft" class="icon-button" type="button" title="Paste to agent without pressing Enter" aria-label="Paste to agent" disabled>${icon('paste')}</button>
</div></div>
<div id="uploads" aria-live="polite"></div><ul id="attachments" class="attachments" aria-label="Attached files"></ul>
</div>
</section>
<div id="status" class="status" role="status" aria-live="polite"></div>
</main><script nonce="${attribute(nonce)}" src="${attribute(scriptUri)}"></script>
</body></html>`;
}

exports.renderSidebar = options => render(options, false);
exports.renderDraft = options => render(options, true);
