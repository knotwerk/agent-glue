
'use strict';
// Focus the main editor before invoking custom editors or diffs: those may otherwise
// follow the active terminal/right-hand group despite a requested column.
async function mainEditorColumn(vscode){
  const groups=vscode.window?.tabGroups?.all;
  if(!groups?.length)return vscode.ViewColumn.One;
  await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
  const column=Math.min(...groups.map(group=>group.viewColumn).filter(column=>column>0));
  return Number.isFinite(column)?column:vscode.ViewColumn.One;
}
module.exports={mainEditorColumn};
