# Agent Glue Mac Dictation

Optional local helper for the microphone button in Agent Glue Companion.
Companion bundles this helper and installs it locally through VS Code’s installer
when its sidebar opens on a Mac. No separate download is needed. For manual
installation, install this VSIX under **Local – Installed**, not on the SSH host.
It is a UI extension, so its command runs locally even in a Remote SSH window.

Enable Dictation in **System Settings → Keyboard → Dictation**. Allow Visual
Studio Code under **Privacy & Security → Accessibility**, and allow System
Events automation if macOS asks. Click the microphone beside the Agent Glue
note to focus that note and invoke VS Code's native **Start Dictation** menu.
No draft text or audio is sent to the remote host by this helper. Apple's
Dictation settings control speech processing. The helper does not type into
terminals or submit notes.

Requires macOS and the English **Start Dictation** menu in VS Code or VS Code
Insiders. If that menu is unavailable, the button reports the failure rather
than pretending to record. This helper has mocked automated tests; actual Mac
menu activation and speech insertion still require live verification.

The helper also supplies **Attach image from Mac clipboard** in the Note actions.
Use Control+Cmd+Shift+4 to copy a screenshot, then click that image button.
Only that explicit action reads the local Mac image clipboard (PNG or TIFF),
converts it to PNG if necessary, and transfers up to 25 MB through VS Code's
command bridge to the remote project inbox. It does not read clipboard text,
monitor the clipboard, or require a separate network listener. This bypasses
webview clipboard/drop delivery; floating screenshot drag remains unsupported
when VS Code does not deliver the drop. Native Mac clipboard execution still
requires live verification.

The helper also provides native file downloads on desktop VS Code. Companion
passes the selected file URI across the SSH connection; the local helper opens
a Save dialog and copies the original bytes using VS Code’s filesystem API.
Downloads do not need macOS Dictation permissions, a browser, or ZeroTier.
The helper can be installed or updated on the first Download action.
