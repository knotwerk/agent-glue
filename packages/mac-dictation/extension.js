'use strict';
const {execFile}=require('node:child_process');
const run=require('node:util').promisify(execFile);
// Only invoke the frontmost VS Code application's native menu; never send keystrokes.
const SCRIPT=`tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set bundleID to bundle identifier of frontApp
  if bundleID is not "com.microsoft.VSCode" and bundleID is not "com.microsoft.VSCodeInsiders" then error "Focus the Agent Glue note in VS Code first."
  tell frontApp
    repeat with topItem in menu bar items of menu bar 1
      try
        repeat with candidate in menu items of menu 1 of topItem
          set candidateName to name of candidate
          if candidateName is not missing value then
          if candidateName starts with "Start Dictation" then
            if not enabled of candidate then error "Dictation is disabled. Enable it in System Settings > Keyboard > Dictation."
            click candidate
            return "started"
          end if
          end if
        end repeat
      on error messageText number messageNumber
        if messageText contains "Dictation is disabled" then error messageText
      end try
    end repeat
  end tell
  error "Start Dictation was not found in VS Code's menus. Enable macOS Dictation; non-English menu names are not supported yet."
end tell`;
function errorDetail(error){
  const text=String(error.stderr||(/^Command failed:/.test(error.message||'')?'The native helper failed. Check macOS permissions and try again.':error.message)||'Unknown native menu error');
  return text.split('\n').filter(line=>!line.startsWith('Command failed:'))[0]?.slice(0,300)||'The native helper failed.';
}
async function start({platform=process.platform,exec=run}={}){
  if(platform!=='darwin')throw new Error('Agent Glue Mac Dictation must be installed locally on your Mac, not on the SSH host.');
  try{await exec('/usr/bin/osascript',['-e',SCRIPT],{timeout:15000,maxBuffer:65536});}
  catch(error){throw new Error(`Could not start macOS Dictation. Allow Visual Studio Code under System Settings > Privacy & Security > Accessibility (and Automation if prompted). ${errorDetail(error)}`);}
}
// Read only on an explicit paste-image action, on the local UI extension host.
const CLIPBOARD_SCRIPT=`ObjC.import('AppKit');
const board = $.NSPasteboard.generalPasteboard;
let data = board.dataForType($.NSPasteboardTypePNG);
if (!data || data.isNil()) {
  const tiff = board.dataForType($.NSPasteboardTypeTIFF);
  if (!tiff || tiff.isNil()) throw new Error('No image in the Mac clipboard. Copy a screenshot first with Control+Cmd+Shift+4.');
  const bitmap = $.NSBitmapImageRep.imageRepWithData(tiff);
  data = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
}
if (!data || data.isNil() || Number(data.length) === 0) throw new Error('Could not read the clipboard image.');
if (Number(data.length) > 25 * 1024 * 1024) throw new Error('Clipboard image must be 25 MB or smaller.');
ObjC.unwrap(data.base64EncodedStringWithOptions(0));`;
async function readClipboardImage({platform=process.platform,exec=run}={}){
  if(platform!=='darwin')throw new Error('Clipboard image helper must run locally on your Mac, not on the SSH host.');
  let stdout;
  try{({stdout}=await exec('/usr/bin/osascript',['-l','JavaScript','-e',CLIPBOARD_SCRIPT],{timeout:15000,maxBuffer:36*1024*1024}));}
  catch(error){throw new Error('Could not read the Mac clipboard image. '+errorDetail(error));}
  const data=stdout.trim();
  const bytes=Buffer.from(data,'base64');
  if(!data||bytes.length>25*1024*1024||bytes.toString('base64')!==data||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Mac clipboard did not return a valid PNG image of 25 MB or smaller.');
  return {data,size:bytes.length,mime:'image/png',name:'screenshot.png'};
}
// Runs in the local UI host so file: destinations mean the user's computer.
async function downloadFile(vscode,source){
  if(!vscode.Uri.isUri(source)||!['file','vscode-remote'].includes(source.scheme))throw new Error('Choose a local or SSH file to download.');
  const stat=await vscode.workspace.fs.stat(source);
  if(!(stat.type&vscode.FileType.File))throw new Error('Download requires a regular file.');
  const name=require('node:path').posix.basename(source.path);
  const target=await vscode.window.showSaveDialog({
    title:'Download file',saveLabel:'Download',
    defaultUri:vscode.Uri.file(require('node:path').join(require('node:os').homedir(),'Downloads',name)),
  });
  if(!target)return {cancelled:true};
  if(target.scheme!=='file')throw new Error('Choose a destination on your computer.');
  if(target.toString()===source.toString())throw new Error('Choose a different destination from the source file.');
  await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Downloading '+name},()=>vscode.workspace.fs.copy(source,target,{overwrite:true}));
  return {cancelled:false};
}
async function readLocalFile(value){
  const fs=require('node:fs/promises'),path=require('node:path');
  if(typeof value!=='string'||value.length>4096)throw Error('Choose a local file path.');
  let file=value;
  if(/^file:/i.test(file))file=require('node:url').fileURLToPath(file);
  else if(file.startsWith('~/'))file=path.join(require('node:os').homedir(),file.slice(2));
  if(!path.isAbsolute(file))throw Error('Choose an absolute path on your computer.');
  const {constants}=require('node:fs');
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NONBLOCK);
  try{
    const stat=await handle.stat();if(!stat.isFile())throw Error('Choose a file, not a folder.');
    if(stat.size>200*1024*1024)throw Error('Files must be 200 MB or smaller.');
    const buffer=Buffer.alloc(stat.size+1);let offset=0;
    while(offset<buffer.length){const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
    if(offset!==stat.size)throw Error('The file changed while uploading. Try again.');
    return {name:path.basename(file),size:offset,data:buffer.subarray(0,offset).toString('base64')};
  }finally{await handle.close();}
}
function activate(context){
  const vscode=require('vscode');
  context.subscriptions.push(vscode.commands.registerCommand('agentGlueMac.status',()=>({platform:process.platform,version:require('./package.json').version,clipboardImage:true,safeNativeErrors:true,nativeDownload:true,localFiles:true,maxFileBytes:200*1024*1024})));
  context.subscriptions.push(vscode.commands.registerCommand('agentGlueMac.readLocalFile',value=>readLocalFile(value)));
  context.subscriptions.push(vscode.commands.registerCommand('agentGlueMac.downloadFile',source=>downloadFile(vscode,source)));
  context.subscriptions.push(vscode.commands.registerCommand('agentGlueMac.readClipboardImage',()=>readClipboardImage()));
  context.subscriptions.push(vscode.commands.registerCommand('agentGlueMac.startDictation',()=>start()));
}
module.exports={readLocalFile,downloadFile,activate,start,SCRIPT,readClipboardImage,CLIPBOARD_SCRIPT};
