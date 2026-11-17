'use strict';
const LIMIT=1024*1024;
function frameClipboard(channel,limit){
  const selection=()=>{
    const element=document.activeElement;
    if(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement){
      if(element.type==='password')return '';
      if(typeof element.selectionStart==='number')return element.value.slice(element.selectionStart,element.selectionEnd);
    }
    return window.getSelection()?.toString()||'';
  };
  let previous='';
  const update=()=>{
    const text=selection();const bounded=text.length<=limit?text:'';
    if(bounded===previous)return;previous=bounded;
    parent.postMessage({type:'previewSelection',channel,text:bounded},'*');
  };
  for(const name of ['selectionchange','select','keyup','mouseup','input'])document.addEventListener(name,update,true);
  const copy=event=>{
    if(!event.isTrusted)return;
    const text=selection();if(!text||text.length>limit)return;
    event.preventDefault();event.stopPropagation();
    event.clipboardData?.setData('text/plain',text);
    parent.postMessage({type:'previewCopySelection',channel,text},'*');
  };
  document.addEventListener('copy',copy,true);
  document.addEventListener('keydown',event=>{
    if((event.ctrlKey||event.metaKey)&&!event.altKey&&!event.shiftKey&&event.key.toLowerCase()==='c')copy(event);
  },true);
}
function outerClipboard(vscode,frame,channel,limit){
  let selection='';const button=document.getElementById('copy-selection');
  const valid=text=>typeof text==='string'&&text.length>0&&text.length<=limit;
  const send=text=>{if(valid(text))vscode.postMessage({type:'copySelection',channel,text});};
  window.addEventListener('message',event=>{
    const message=event.data;
    if(event.source!==frame.contentWindow||message?.channel!==channel)return;
    if(message.type==='previewSelection'&&typeof message.text==='string'&&message.text.length<=limit){selection=message.text;button.disabled=!selection;}
    // An active document can propose selection text, but cannot copy on load.
    // Keyboard copy inside the child carries browser user activation to us.
    if(message.type==='previewCopySelection'&&navigator.userActivation?.isActive)send(message.text);
  });
  button.addEventListener('mousedown',event=>event.preventDefault());
  button.addEventListener('click',event=>{if(event.isTrusted)send(selection);});
  // VS Code's menu Copy uses execCommand on this outer document. Its trusted
  // copy event does not bubble out of the opaque inner document automatically.
  document.addEventListener('copy',event=>{
    if(!event.isTrusted)return;
    const text=window.getSelection()?.toString()||selection;
    if(!valid(text))return;
    event.preventDefault();event.clipboardData?.setData('text/plain',text);send(text);
  });
}
const frameScript=channel=>`(${frameClipboard.toString()})(${JSON.stringify(channel)},${LIMIT});`;
const outerScript=()=>`(${outerClipboard.toString()})(vscode,frame,channel,${LIMIT});`;
const validCopy=(message,channel)=>message?.type==='copySelection'&&message.channel===channel&&typeof message.text==='string'&&message.text.length>0&&message.text.length<=LIMIT;
module.exports={frameScript,outerScript,validCopy};
