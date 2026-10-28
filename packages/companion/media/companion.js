'use strict';

(() => {
  const vscode = acquireVsCodeApi();
  const byId = id => document.getElementById(id);
  const send = message => vscode.postMessage(message);
  const draftOnly = document.body.dataset.view === 'draft';
  const textField = byId('draft-text');
  const targetSelect = byId('target');
  const statusElement = byId('status');
  let state = { sessions: [], files: [], draft: {}, uploads: [] };
  let draftId;
  const expandedReviews=new Set(),requestedReviews=new Set();
  const closedReviewNodes=new Set(),expandedTasks=new Set();
  let reviewFolder;
  let recentSession, recentLimit=20;
  const sessionFileOptions={...vscode.getState?.()?.sessionFileOptions};
  let fileOptions={type:'all',age:'all',sort:'recent'};
  function fileCategory(file){
    const ext=(file.path.split('.').pop()||'').toLowerCase();
    const categories={images:['png','jpg','jpeg','gif','webp','svg','avif','bmp','tiff','ico'],documents:['md','markdown','html','htm','txt','pdf','doc','docx','rtf'],code:['js','jsx','ts','tsx','cjs','mjs','py','pyi','css','scss','sh','bash','zsh','go','rs','java','c','cpp','h','rb','sql'],data:['json','jsonl','csv','tsv','xlsx','xls','yaml','yml','xml','toml'],archives:['zip','gz','tar','tgz','7z','rar','bz2','xz']};
    return Object.keys(categories).find(key=>categories[key].includes(ext))||'other';
  }
  let lastFileState;
  let pendingText;
  let editTimer;
  let localError = '';
  let queue = Promise.resolve();
  const waits = new Map();
  const localUploads = new Map();
  const MAX_BYTES = 25 * 1024 * 1024;
  const CHUNK_BYTES = 192 * 1024;
  const pinSvg = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="m6 2 6 6-2 1-1 3-2-2-4 4 3-5-2-2 3-1z"/></svg>';

  function relativeTime(value){
    const timestamp=Date.parse(value);
    if(!Number.isFinite(timestamp))return '';
    const minutes=Math.floor(Math.max(0,Date.now()-timestamp)/60000);
    if(minutes<1)return 'just now';
    if(minutes<60)return minutes+' min ago';
    const hours=Math.floor(minutes/60);
    if(hours<24)return hours+' hr ago';
    const days=Math.floor(hours/24);
    return days+' '+(days===1?'day':'days')+' ago';
  }
  function element(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }

  const actionPaths={
    '↓':'M8 2v8m-3-3 3 3 3-3M3 11v3h10v-3',
    '↗':'M9 2h5v5m0-5L7 9M6 3H2v11h11v-4',
    '⧉':'M6 6h8v8H6zM10 3V2H2v8h1',
    '✎':'m3 10 7-7 3 3-7 7-4 1zM9 4l3 3',
    '×':'m4 4 8 8M12 4l-8 8'
  };
  function fileIcon(file){
    const extension=(file.split('.').pop()||'').toLowerCase();
    const types={md:'markdown',markdown:'markdown',py:'python',pyi:'python',csv:'table',tsv:'table',xlsx:'table',xls:'table',html:'html',htm:'html',json:'json',jsonl:'json',js:'javascript',cjs:'javascript',mjs:'javascript',ts:'typescript',tsx:'typescript',css:'css',png:'image',jpg:'image',jpeg:'image',gif:'image',webp:'image',svg:'image',pdf:'pdf',zip:'zip',gz:'zip',tar:'zip',txt:'document'};
    const icon=element('span','item-icon file-type-icon material-'+(types[extension]||'document'));
    icon.setAttribute('aria-hidden','true');
    return icon;
  }
  function parentPath(file){
    const cwd=state.sessions.find(s=>s.id===state.selectedSessionId)?.cwd?.replace(/\/$/,'');
    const relative=cwd&&file.startsWith(cwd+'/')?file.slice(cwd.length+1):file;
    const folders=relative.split('/').filter(Boolean).slice(0,-1);
    return folders.length?(folders.length>2?'…/':'')+folders.slice(-2).join('/'):(cwd?.split('/').pop()||'.');
  }

  function actionButton(title, action, glyph) {
    const button = element('button', 'icon-button', actionPaths[glyph] ? undefined : glyph);
    if(actionPaths[glyph])button.innerHTML='<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+actionPaths[glyph]+'"/></svg>';
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('click', action);
    return button;
  }

  function status(message, isError = false) {
    statusElement.textContent = message || '';
    statusElement.classList.toggle('error', isError);
  }

  function showError(message) {
    localError = message;
    status(message, true);
  }

  function formatSize(bytes) {
    if (!Number.isFinite(bytes)) return '';
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${bytes} B`;
  }

  function reviewBranch(key, label, className) {
    const branch=element('details',className);
    branch.open=!closedReviewNodes.has(key);
    const summary=element('summary','',label);
    summary.dataset.reviewKey=key;
    branch.append(summary);
    branch.addEventListener('toggle',()=>{
      if(!branch.isConnected)return;
      if(branch.open)closedReviewNodes.delete(key);else closedReviewNodes.add(key);
    });
    return branch;
  }

  function reviewLeaf(item, doc, index, label) {
    const leaf=element('li','review-file');
    const open=element('button','text-button',label||doc.label||doc.relative||doc.path);
    open.type='button';open.dataset.reviewKey=item.id+':file:'+index;
    open.title=doc.missing?(doc.githubUrl?'Unavailable locally — open in GitHub':'File unavailable'):(doc.path||doc.relative||doc.label);
    open.prepend(fileIcon(doc.relative||doc.path||doc.label||''));
    if(doc.status)open.append(element('span','change-status',doc.status));
    if(doc.missing)open.append(element('span','file-unavailable',doc.githubUrl?'Open in GitHub':'Unavailable'));
    open.disabled=!!doc.missing&&!doc.githubUrl;
    open.addEventListener('click',()=>send({type:'openReviewFile',id:item.id,index}));
    leaf.append(open);return leaf;
  }

  function reviewGroups(item) {
    const fragment=document.createDocumentFragment();
    const indexed=item.reviewDocuments.map((doc,index)=>({doc,index}));
    for(const [group,title] of [['changes','Changes'],['review','Review material']]){
      const entries=indexed.filter(({doc})=>(doc.group||'review')===group);
      const branch=reviewBranch(item.id+':'+group,title+' ('+entries.length+')','review-group');
      if(!entries.length){branch.append(element('p','empty',group==='changes'?'No changed files.':'No linked review material.'));fragment.append(branch);continue;}
      const list=element('ul','review-file-tree');
      if(group==='review')for(const {doc,index} of entries)list.append(reviewLeaf(item,doc,index));
      else {
        const directories=new Map([['',list]]);
        for(const {doc,index} of entries.sort((a,b)=>(a.doc.relative||a.doc.label||'').localeCompare(b.doc.relative||b.doc.label||''))){
          const parts=(doc.relative||doc.label||doc.path||'File').split('/').filter(Boolean);
          const filename=parts.pop();let parent=list,prefix='';
          for(const name of parts){
            prefix=prefix?prefix+'/'+name:name;
            if(!directories.has(prefix)){
              const row=element('li');const folder=reviewBranch(item.id+':directory:'+prefix,name,'review-directory');
              const children=element('ul','review-file-tree');folder.append(children);row.append(folder);parent.append(row);directories.set(prefix,children);
            }
            parent=directories.get(prefix);
          }
          parent.append(reviewLeaf(item,doc,index,filename));
        }
      }
      branch.append(list);fragment.append(branch);
    }
    return fragment;
  }

  let reviewGeneration;
  function renderFiles() {
    if (draftOnly) return;
    const container = byId('files');
    const fragment = document.createDocumentFragment();
    const tab=['prs','tasks'].includes(state.resourceTab)?state.resourceTab:'files';
    const focusedReview=document.activeElement?.dataset.reviewKey;
    // Native toggle events are queued; capture the DOM before replacing it so a
    // host update immediately after a keyboard/click toggle keeps its state.
    for(const branch of container.querySelectorAll('.review-group, .review-directory')){
      const key=branch.firstElementChild?.dataset.reviewKey;
      if(key){if(branch.open)closedReviewNodes.delete(key);else closedReviewNodes.add(key);}
    }
    for(const row of container.querySelectorAll('.task-item')){if(row.open)expandedTasks.add(row.dataset.taskKey);else expandedTasks.delete(row.dataset.taskKey);}
    if(reviewFolder!==state.resourceFolder){expandedTasks.clear();requestedReviews.clear();expandedReviews.clear();closedReviewNodes.clear();reviewFolder=state.resourceFolder;}
    if(reviewGeneration!==state.resourceGeneration){requestedReviews.clear();reviewGeneration=state.resourceGeneration;}
    for(const item of state.resourceItems||[])if(item.reviewDocuments||item.reviewError)requestedReviews.delete(item.id);
    byId('task-controls').hidden=tab!=='tasks';
    byId('resource-controls').hidden=tab!=='prs';
    byId('file-controls').hidden=tab!=='files';
    if(tab==='files'&&recentSession!==state.selectedSessionId){
      recentSession=state.selectedSessionId;recentLimit=20;
      fileOptions={type:'all',age:'all',sort:'recent',...sessionFileOptions[recentSession]};
    }
    for(const key of ['type','age','sort'])byId('file-'+key).value=fileOptions[key];
    byId('file-filter-notice').hidden=true;
    byId('pr-filter').hidden=tab!=='prs';
    byId('pr-filter').value=state.prFilter||'priority';
    byId('pr-sort').value=state.prSort||'title';
    byId('pr-read-filter').value=state.prReadFilter||'all';
    byId('pr-filter').title=byId('pr-filter').selectedOptions[0]?.textContent||'Filter pull requests';
    container.setAttribute('aria-label',tab==='prs'?'Pull requests':'Pinned and recent files');
    if(tab==='tasks'){
      container.setAttribute('aria-label','Project tasks');
      const filter=byId('task-filter').value;
      const items=(state.resourceItems||[]).filter(task=>filter==='all'||(filter==='done'?task.status==='done':task.status!=='done'));
      for(const task of items){
        const row=element('details','task-item');row.dataset.taskKey=task.id;row.open=expandedTasks.has(task.id);
        const title=element('summary');
        const status=element('span','task-status task-'+task.status,{active:'●',blocked:'!',review:'◉',done:'✓'}[task.status]||'○');
        status.title=task.status;status.setAttribute('aria-label',task.status);
        title.append(status,element('span','item-label',task.label));title.title=task.label;
        const updated=element('time','task-updated',relativeTime(task.updatedAt));
        updated.dateTime=task.updatedAt;updated.title='Last updated: '+new Date(task.updatedAt).toLocaleString();
        title.append(updated);row.append(title);
        row.append(element('p','task-meta',[task.status,task.owner].filter(Boolean).join(' · ')));
        if(task.summary)row.append(element('p','task-description',task.summary));
        if(task.next)row.append(element('p','task-description','Next: '+task.next));
        fragment.append(row);
      }
      container.replaceChildren(fragment);
      byId('files-empty').textContent=state.resourceStatus||(items.length?'':(state.resourceItems||[]).length?'No tasks match this filter.':'No tracked tasks in this project. Click Set up with agent to paste a task-tracking request into the selected terminal, then press Enter.');
      byId('files-empty').hidden=items.length>0&&!state.resourceStatus;
      return;
    }
    if(tab==='prs'){
      const items=state.resourceItems||[];
      for(const item of items){
        const tree=element('details','review-files pr-resource');tree.open=expandedReviews.has(item.id);
        const summary=element('summary','pr-row');summary.dataset.reviewKey=item.id+':files';
        summary.title='Expand review files';
        const chevron=element('span','pr-chevron','›');chevron.setAttribute('aria-hidden','true');summary.append(chevron);
        const button=element('button','item-main');button.type='button';
        button.title=[item.label,item.description].filter(Boolean).join('\n');
        button.append(element('span','item-label',item.label));
        button.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();send({type:'openResource',id:item.id});});
        summary.append(button);
        const mark=actionButton(item.markedRead?'Mark unread':'Mark read',event=>{
          event.preventDefault();event.stopPropagation();
          send({type:'markPrRead',id:item.id,read:!item.markedRead,generation:state.resourceGeneration});
        },'');
        mark.classList.add('pr-read-mark');
        if(item.newComments)mark.classList.add('has-new-comments');
        if(item.markedRead)mark.classList.add('is-read');
        mark.title=(item.newComments?'New comments · ':'')+(item.markedRead?'Marked read · Mark unread':'Mark read');
        mark.setAttribute('aria-pressed',String(Boolean(item.markedRead)));
        summary.append(mark);tree.append(summary);
        tree.addEventListener('toggle',()=>{
          if(!tree.isConnected)return;
          if(tree.open){expandedReviews.add(item.id);if(!item.reviewDocuments&&!item.reviewError&&!requestedReviews.has(item.id)&&state.resourceStatus!=='Loading…'){requestedReviews.add(item.id);send({type:'expandResource',id:item.id,generation:state.resourceGeneration});}}
          else expandedReviews.delete(item.id);
        });
        if(item.reviewError)tree.append(element('p','empty',item.reviewError));
        else if(item.reviewDocuments)tree.append(reviewGroups(item));
        else tree.append(element('p','empty','Loading review files…'));
        fragment.append(tree);
      }
      container.replaceChildren(fragment);
      if(focusedReview)Array.from(container.querySelectorAll('[data-review-key]')).find(node=>node.dataset.reviewKey===focusedReview)?.focus({preventScroll:true});
      byId('file-count').textContent=items.length?String(items.length):'';
      byId('files-empty').textContent=state.resourceStatus||`No pull requests match this filter in ${state.resourceFolder||'the selected project'}.`;
      byId('files-empty').hidden=items.length>0&&!state.resourceStatus;
      return;
    }
    byId('files-empty').textContent=state.filesMessage||'Files mentioned by this agent appear here.';
    const cutoff=fileOptions.age==='all'?0:Date.now()-Number(fileOptions.age)*3600000;
    const matching=state.files.filter(file=>(fileOptions.type==='all'||fileCategory(file)===fileOptions.type)&&(!cutoff||(file.modified||0)>=cutoff));
    const byName=(a,b)=>(a.label||a.path.split('/').pop()).localeCompare(b.label||b.path.split('/').pop(),undefined,{numeric:true,sensitivity:'base'})||a.path.localeCompare(b.path);
    const recent=file=>Math.max(file.seen||0,file.modified||0);
    matching.sort(fileOptions.sort==='name'?byName:(a,b)=>recent(b)-recent(a)||byName(a,b));
    const filtered=state.files.length-matching.length;
    byId('file-filter-notice').hidden=filtered===0;
    byId('file-filter-count').textContent=filtered+' hidden by filters';
    const pins=matching.filter(file=>file.pinned);
    const recents=matching.filter(file=>!file.pinned);
    if(!recents.length)recentLimit=20;
    const groups = [['Pinned', pins], ['Recent', recents.slice(0,recentLimit)]];
    for (const [label, files] of groups) {
      if (!files.length) continue;

      for (const file of files) {
        const row = element('div', `item file-item${file.missing ? ' missing' : ''}`);
        row.setAttribute('role', 'listitem');
        const button = element('button', 'item-main');
        button.type = 'button';
        button.title = `${file.path}${file.missing ? ' — file unavailable' : ''}`;
        button.setAttribute('aria-label', `Open ${file.label || file.path}${file.missing ? ', file unavailable' : ''}`);
        const previewable=/\.(md|markdown|html?)$/i.test(file.path||'');
        const glyph = fileIcon(file.path||'');
        if(file.pinned){const badge=element('span','pin-badge');badge.innerHTML=pinSvg;badge.title='Pinned';glyph.append(badge);}
        const label=element('span','file-text');
        const heading=element('span','file-heading');
        heading.append(element('span','item-label',file.label||file.path));
        if(Number.isFinite(file.modified)){
          const iso=new Date(file.modified).toISOString();
          const modified=element('time','file-modified',relativeTime(iso));
          modified.dateTime=iso;modified.title='Last modified: '+new Date(file.modified).toLocaleString();
          heading.append(modified);
        }
        label.append(heading);
        const location=element('span','file-path',parentPath(file.path||''));
        location.title=file.path||'';label.append(location);
        if(file.pinned&&file.description)label.append(element('span','file-description',file.description));
        button.append(glyph,label);
        button.addEventListener('click', () => send({ type: 'previewFile', id: file.id }));
        row.addEventListener('contextmenu',event=>{event.preventDefault();send({type:'fileMenu',id:file.id});});
        const actions = element('div', 'file-actions');
        const pin = actionButton(file.pinned ? `Unpin ${file.label || 'file'}` : `Pin ${file.label || 'file'}`, () => send({ type: 'fileAction', id: file.id, action: file.pinned ? 'unpin' : 'pin' }));
        pin.innerHTML = pinSvg;
        actions.append(actionButton('Download file',()=>send({type:'fileAction',id:file.id,action:'download'}),'↓'));
        if(previewable)actions.append(actionButton('Open in browser',()=>send({type:'fileAction',id:file.id,action:'browser'}),'↗'),actionButton('Copy browser link',()=>send({type:'fileAction',id:file.id,action:'copyLink'}),'⧉'));
        if(file.pinned)actions.append(actionButton(file.description?'Edit description':'Add description',()=>send({type:'fileAction',id:file.id,action:'describe'}),'✎'));
        actions.append(pin);
        row.append(button, actions);
        fragment.append(row);
      }
    }
    if(recents.length>20){
      const controls=element('div','recent-controls');
      const count=element('span','recent-count',`${Math.min(recentLimit,recents.length)} of ${recents.length} recent files`);
      controls.append(count);
      if(recentLimit<recents.length){
        const more=element('button','text-button',`Show ${Math.min(20,recents.length-recentLimit)} more`);more.type='button';
        more.addEventListener('click',()=>{const firstNew=pins.length+recentLimit;recentLimit+=20;renderFiles();container.querySelectorAll('.file-item > .item-main')[firstNew]?.focus();});
        controls.append(more);
      }
      if(recentLimit>20){
        const less=element('button','text-button','Show fewer');less.type='button';
        less.addEventListener('click',()=>{recentLimit=20;renderFiles();container.querySelector('.file-item > .item-main')?.focus();container.scrollTop=0;});
        controls.append(less);
      }
      fragment.append(controls);
    }
    container.replaceChildren(fragment);
    byId('files-empty').hidden = matching.length !== 0;
    if(state.files.length&&!matching.length)byId('files-empty').textContent='No files match these filters. Try All types or Any time.';
    byId('file-count').textContent = state.files.length ? String(state.files.length) : '';
  }

  function renderDraft() {
    const draft = state.draft || {};
    const changedDraft = draftId !== draft.id;
    if (changedDraft) {
      clearTimeout(editTimer);
      pendingText = undefined;
      draftId = draft.id;
    }
    if (pendingText === draft.text) pendingText = undefined;
    if (changedDraft || (pendingText === undefined && document.activeElement !== textField)) textField.value = draft.text || '';
    const options = [{ id: '', name: 'No agent selected' }, ...state.sessions];
    if (draft.targetId && !options.some(option => option.id === draft.targetId)) options.push({ id: draft.targetId, name: `${draft.targetName || draft.targetId} (unavailable)`, available: false });
    const optionsSignature = JSON.stringify(options.map(option => [option.id, option.name, option.available]));
    if (targetSelect.dataset.options !== optionsSignature) {
      targetSelect.replaceChildren(...options.map(session => {
        const option = element('option', '', session.name || session.id);
        option.value = session.id;
        option.disabled = session.available === false;
        return option;
      }));
      targetSelect.dataset.options = optionsSignature;
    }
    targetSelect.value = draft.targetId || '';
    const target = state.sessions.find(session => session.id === draft.targetId);
    const paste = byId('paste-draft');
    const pasteLabel = `Paste to ${draft.targetName || target?.name || 'agent'}`;
    paste.setAttribute('aria-label', pasteLabel);
    paste.title = `${pasteLabel} without pressing Enter`;
    paste.disabled = !draft.targetId || !target || target.available === false;
    const attachments = byId('attachments');
    attachments.replaceChildren(...(draft.attachments || []).map(attachment => {
      const row = element('li', 'attachment');
      row.title = attachment.path;
      row.append(element('span', 'item-icon', '↳'), element('span', 'attachment-name', attachment.name), element('span', 'attachment-size', formatSize(attachment.size)));
      row.append(actionButton(`Remove ${attachment.name} from note`,()=>send({type:'removeAttachment',path:attachment.path}),'×'));
      return row;
    }));
  }

  function renderUploads() {
    const uploads = new Map((state.uploads || []).map(upload => [upload.id, upload]));
    for (const [id, local] of localUploads) uploads.set(id, { ...uploads.get(id), ...local });
    byId('uploads').replaceChildren(...[...uploads.values()].filter(upload => upload.status !== 'complete').map(upload => {
      const row = element('div', 'upload');
      row.append(element('span', 'upload-name', upload.name), element('span', 'upload-state', upload.error ? 'Failed' : upload.status === 'queued' ? 'Queued' : `${Math.min(100, Math.round((upload.received || 0) / (upload.size || 1) * 100))}%`));
      if (upload.error) row.append(element('span', 'upload-error', upload.error));
      else {
        const progress = element('progress');
        progress.max = upload.size || 1;
        progress.value = upload.received || 0;
        progress.setAttribute('aria-label', `Uploading ${upload.name}`);
        row.append(progress);
      }
      return row;
    }));
  }

  function flushEdit() {
    clearTimeout(editTimer);
    pendingText = textField.value;
    send({ type: 'editDraft', text: textField.value });
  }

  textField.addEventListener('input', () => {
    pendingText = textField.value;
    clearTimeout(editTimer);
    editTimer = setTimeout(flushEdit, 160);
  });
  textField.addEventListener('blur', flushEdit);
  byId('clear-text').addEventListener('click', () => {
    textField.value = '';
    flushEdit();
    textField.focus();
  });
  targetSelect.addEventListener('change', () => {
    flushEdit();
    send({ type: 'changeTarget', targetId: targetSelect.value });
  });
  for (const [id, type] of [['copy-draft', 'copyDraft'], ['paste-draft', 'pasteDraft']]) byId(id).addEventListener('click', () => {
    flushEdit();
    send({ type, text: textField.value });
  });
  function startDictation(){
    flushEdit();textField.focus();
    requestAnimationFrame(()=>send({type:'dictate'}));
  }
  byId('dictate').addEventListener('click',startDictation);
  let lastCaps;
  textField.addEventListener('keydown',event=>{
    if(event.key!=='CapsLock'){lastCaps=undefined;return;}
    if(event.repeat||event.isComposing||event.ctrlKey||event.metaKey||event.altKey)return;
    const now=performance.now();
    if(lastCaps!==undefined&&now-lastCaps<=500){lastCaps=undefined;startDictation();}
    else lastCaps=now;
  });
  textField.addEventListener('blur',()=>{lastCaps=undefined;});
  if (!draftOnly) {
    const resize=byId('composer-resize');
    const saved=vscode.getState?.()||{};
    const setHeight=value=>{
      const max=Math.max(72,window.innerHeight-150);
      const height=Math.max(72,Math.min(max,value));
      textField.style.height=height+'px';
      resize.setAttribute('aria-valuenow',String(Math.round(height)));
      resize.setAttribute('aria-valuemax',String(Math.round(max)));
      vscode.setState?.({...vscode.getState?.(),noteHeight:height});
    };
    if(Number.isFinite(saved.noteHeight))setHeight(saved.noteHeight);
    let drag;
    resize.addEventListener('pointerdown',event=>{
      if(event.button!==0)return;
      drag={y:event.clientY,height:textField.getBoundingClientRect().height};
      resize.setPointerCapture(event.pointerId);event.preventDefault();
    });
    resize.addEventListener('pointermove',event=>{if(drag)setHeight(drag.height+drag.y-event.clientY);});
    const stop=()=>{drag=undefined;};
    resize.addEventListener('pointerup',stop);resize.addEventListener('pointercancel',stop);resize.addEventListener('lostpointercapture',stop);
    resize.addEventListener('keydown',event=>{
      if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
      event.preventDefault();
      setHeight(event.key==='Home'?72:event.key==='End'?window.innerHeight:textField.getBoundingClientRect().height+(event.key==='ArrowUp'?20:-20));
    });
    window.addEventListener('resize',()=>setHeight(textField.getBoundingClientRect().height));
    byId('open-draft').addEventListener('click', () => { flushEdit(); send({ type: 'openDraft', text: textField.value }); });
    for(const key of ['type','age','sort'])byId('file-'+key).addEventListener('change',()=>{
      fileOptions[key]=byId('file-'+key).value;recentLimit=20;
      sessionFileOptions[state.selectedSessionId]={...fileOptions};
      vscode.setState?.({...vscode.getState?.(),sessionFileOptions});renderFiles();
    });
    byId('file-show-all').addEventListener('click',()=>{
      fileOptions.type='all';fileOptions.age='all';recentLimit=20;
      sessionFileOptions[state.selectedSessionId]={...fileOptions};
      vscode.setState?.({...vscode.getState?.(),sessionFileOptions});renderFiles();
    });
    byId('task-filter').addEventListener('change',renderFiles);
    byId('task-instructions').addEventListener('click',()=>send({type:'setupTasks'}));
    byId('pr-sort').addEventListener('change',()=>send({type:'prSort',sort:byId('pr-sort').value}));
    byId('pr-read-filter').addEventListener('change',()=>send({type:'prReadFilter',filter:byId('pr-read-filter').value}));
    byId('pr-filter').addEventListener('change',()=>send({type:'prFilter',filter:byId('pr-filter').value}));
  }

  function expectReply(id, type, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waits.delete(id);
        reject(new Error('The server did not respond. Your note is safe; choose the file again to retry.'));
      }, 30000);
      waits.set(id, { type, resolve, reject, timer });
      send(message);
    });
  }

  async function upload(file, id, targetId, batchId) {
    const local = localUploads.get(id);
    try {
      local.status = 'uploading';
      renderUploads();
      await expectReply(id, 'uploadReady', { type: 'uploadStart', id, targetId, batchId, name: file.name || 'screenshot.png', size: file.size, mime: file.type });
      for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
        const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
        let binary = '';
        for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
        const reply = await expectReply(id, 'uploadAck', { type: 'uploadChunk', id, offset, data: btoa(binary) });
        if (reply.received !== offset + bytes.length) throw new Error('The server returned an unexpected upload offset. Choose the file again to retry.');
        local.received = reply.received;
        renderUploads();
      }
      await expectReply(id, 'uploadComplete', { type: 'uploadFinish', id });
      localUploads.delete(id);
      localError = '';
      status(`${local.name} is ready on the server.`);
    } catch (error) {
      send({type:'uploadAbort',id});
      local.status = 'error';
      local.error = error.message || 'Upload failed.';
      showError(`Could not upload ${local.name}. ${local.error}`);
    }
    renderUploads();
  }

  function enqueueFiles(files) {
    const targetId=state.draft?.targetId,batchId=crypto.randomUUID(),batch=[];
    for (const file of files) {
      if (file.size > MAX_BYTES) {
        showError(`${file.name}: files must be 25 MB or smaller.`);
        continue;
      }
      const id = crypto.randomUUID();
      localUploads.set(id, { id, name: file.name || 'screenshot.png', size: file.size, received: 0, status: 'queued' });
      batch.push({file,id});
    }
    if(batch.length)queue=queue.then(async()=>{
      try{
        await expectReply(batchId,'uploadBatchReady',{type:'uploadBatchStart',id:batchId,targetId});
        for(const {file,id} of batch)await upload(file,id,targetId,batchId);
      }catch(error){
        for(const {id} of batch){const local=localUploads.get(id);if(local){local.status='error';local.error=error.message;}}
        showError(error.message);renderUploads();
      }finally{send({type:'uploadBatchEnd',id:batchId});}
    });
    renderUploads();
  }

  const pasteImage=byId('paste-image');
  pasteImage.hidden=!/Mac/i.test(navigator.platform);
  pasteImage.addEventListener('click',()=>{localError='';flushEdit();send({type:'pasteClipboardImage'});});
  const dropZone = byId('drop-zone');
  const fileInput = byId('file-input');
  byId('choose-files').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { enqueueFiles([...fileInput.files]); fileInput.value = ''; });
  dropZone.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target === dropZone) { event.preventDefault(); fileInput.click(); }
  });
  function acceptDrag(event) {
    event.preventDefault();
    event.stopPropagation();
    if(event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    dropZone.classList.add('drag-over');
  }
  document.addEventListener('dragenter', acceptDrag, true);
  document.addEventListener('dragover', acceptDrag, true);
  document.addEventListener('dragleave', event => { if (!event.relatedTarget) dropZone.classList.remove('drag-over'); });
  document.addEventListener('drop', event => {
    event.preventDefault();
    event.stopPropagation();
    dropZone.classList.remove('drag-over');
    const transfer = event.dataTransfer;
    let files = [...(transfer?.files || [])];
    if (!files.length) files = [...(transfer?.items || [])].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
    if (files.length) enqueueFiles(files);
    else showError('This drag did not include an image file. Save the screenshot, then drop the saved file or paste the image here.');
  }, true);
  document.addEventListener('paste', event => {
    const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
    if (files.length) { event.preventDefault(); enqueueFiles(files); }
  });

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'state') {
      state = { sessions: [], files: [], draft: {}, uploads: [], ...message.state };
      const fileState=JSON.stringify([Math.floor(Date.now()/60000),state.selectedSessionId,state.sessions,state.files,state.filesMessage,state.resourceTab,state.prFilter,state.resourceItems,state.resourceStatus,state.resourceFolder,state.resourceGeneration]);
      if(fileState!==lastFileState){lastFileState=fileState;renderFiles();}
      renderDraft();
      renderUploads();
      if (localError) status(localError, true);
      else status(typeof state.status === 'string' ? state.status : state.status?.message || '', Boolean(state.status?.error));
    } else if (message.type === 'requestDictation') {
      startDictation();
    } else if (message.type === 'dictationReady') {
      textField.focus();
      requestAnimationFrame(() => send({type:'startDictation',id:message.id}));
    } else if (message.type === 'focusDraft') textField.focus();
    else if (message.id && waits.has(message.id)) {
      const wait = waits.get(message.id);
      if (message.type === 'uploadError' || message.type === wait.type) {
        clearTimeout(wait.timer);
        waits.delete(message.id);
        if (message.type === 'uploadError') wait.reject(new Error(message.error || 'Upload failed.'));
        else wait.resolve(message);
      }
    }
  });
  send({ type: 'ready', clientPlatform: /Mac/i.test(navigator.platform) ? 'mac' : 'other' });
  if (draftOnly) textField.focus();
})();
