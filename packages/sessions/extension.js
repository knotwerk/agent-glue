const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const TMUX_FIELD_SEP = '\x1f';
const AGENT_PROGRAMS = ['claude', 'claude2', 'claudel', 'claudelp', 'codex', 'codex2', 'codex3', 'codexl'];
const AGENT_PROGRAM_PATTERN = AGENT_PROGRAMS
    .slice()
    .sort((a, b) => b.length - a.length)
    .join('|');
const ATTACH_POLL_INTERVAL_MS = 5000;
const RENAME_POLL_INTERVAL_MS = 1000;
const DISCOVERY_OPTIONS = { timeout: 1500, maxBuffer: 4 * 1024 * 1024 };
// A launcher creates the server session before its existing VS Code terminal
// registers as a tmux client. Give that client two attach polls to appear.
const NEW_SESSION_GRACE_MS = 10000;
const TITLE_OVERRIDES_KEY = 'agentTmuxRestore.titleOverrides';
const ATTACHMENTS_KEY = 'agentTmuxRestore.attachments.v1';
const ATTACHMENT_ENV = 'AGENT_GLUE_ATTACHMENT_TOKEN';
const MAX_ATTACHMENTS = 1000;
const validToken = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const validIdentity = value => typeof value === 'string' && /^\d+:\$\d+:\d+$/.test(value);
const GENERIC_TERMINAL_NAMES = new Set([
    'agent-tmux-attach',
    'agent-tmux-attach-zsh',
    'bash',
    'node',
    'sh',
    'tmux',
    'zsh',
    ...AGENT_PROGRAMS,
]);
const GENERATED_ADJECTIVES = new Set(['bright', 'calm', 'dark', 'swift', 'keen', 'bold', 'warm', 'cool', 'sharp', 'mild']);
const GENERATED_NOUNS = new Set(['reef', 'ember', 'spark', 'drift', 'pulse', 'grove', 'bloom', 'frost', 'wave', 'shore']);

const SCRIPT_ROOT = resolveScriptRoot();
const ATTACH_SCRIPT = path.join(__dirname, 'helpers', 'agent-tmux-attach.zsh');
const RENAME_SCRIPT = path.join(__dirname, 'helpers', 'agent-tmux-rename.zsh');

const terminalSessions = new Map();
const terminalSessionIdentities = new Map();
const terminalNames = new Map();
const terminalPids = new WeakMap();
let sessionTerminals = new Map();
let taskOutput;
let attachmentState;
let attachments = new Map();
const lastKnownNames = new Map();

let operationQueue = Promise.resolve();
const pendingPolls = new Map();
let activatedAt, firstDiscovery = true;
function startupLog(stage, details = '') {
    console.info(`[Agent Glue startup] Sessions ${stage}: ${Date.now() - activatedAt}ms ${details}`);
}

function resolveScriptRoot() {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || require('os').homedir();
}

function realpath(candidate) {
    try {
        return fs.realpathSync(candidate);
    } catch {
        return undefined;
    }
}

function schedule(label, task) {
    // Timer ticks are replaceable observations, not user actions. A slow pass
    // must not leave seconds of obsolete polls queued behind it.
    const poll = label === 'renamePoll' || label === 'attachPoll';
    if (poll && pendingPolls.has(label)) return pendingPolls.get(label);
    operationQueue = operationQueue
        .catch(() => {})
        .then(task)
        .catch(error => warn(label, error));
    if (poll) {
        const current = operationQueue;
        pendingPolls.set(label, current);
        void current.then(() => { if (pendingPolls.get(label) === current) pendingPolls.delete(label); });
    }
    return operationQueue;
}

function warn(label, error) {
    console.warn(`[tmux-claude-attach] ${label}: ${error?.message || error}`);
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function getAgentSessions() {
    try {
        const format = `#{session_name}${TMUX_FIELD_SEP}#{@title}${TMUX_FIELD_SEP}#{@agent_user_named}${TMUX_FIELD_SEP}#{session_created}${TMUX_FIELD_SEP}#{session_id}${TMUX_FIELD_SEP}#{pid}`;
        const { stdout } = await execAsync(`tmux list-sessions -F ${shellQuote(format)} 2>/dev/null`, DISCOVERY_OPTIONS);
        return stdout.trim().split('\n')
            .filter(Boolean)
            .map(line => {
                const [session, title, userNamed, created, id, serverPid] = line.split(TMUX_FIELD_SEP);
                const normalizedUserNamed = normalizeName(userNamed);
                return {
                    session,
                    title: normalizedUserNamed || title || nameFromSession(session),
                    tmuxTitle: title || nameFromSession(session),
                    userNamed: normalizedUserNamed,
                    created: Number(created || 0),
                    identity: id && serverPid ? `${serverPid}:${id}:${created}` : undefined,
                };
            })
            .filter(item => isAgentSession(item.session))
            .sort((a, b) => a.created - b.created || a.session.localeCompare(b.session));
    } catch {
        return undefined; // An incomplete read must not erase known sessions.
    }
}

async function getTmuxClientSessionsByPid() {
    try {
        const format = `#{client_pid}${TMUX_FIELD_SEP}#{client_session}`;
        const [{ stdout }, processes] = await Promise.all([
            execAsync(`tmux list-clients -F ${shellQuote(format)} 2>/dev/null`, DISCOVERY_OPTIONS),
            getProcessTable(),
        ]);
        if (!processes) return undefined;
        const result = new Map();
        for (const line of stdout.trim().split('\n').filter(Boolean)) {
            const [pid, session] = line.split(TMUX_FIELD_SEP);
            if (!pid || !session || !isAgentSession(session)) continue;
            result.set(String(pid), session);
            for (const ancestor of shellAncestors(pid, processes)) {
                if (!result.has(ancestor)) {
                    result.set(ancestor, session);
                }
            }
        }
        return result;
    } catch {
        return undefined;
    }
}

async function getProcessTable() {
    try {
        const { stdout } = await execAsync('ps -eo pid=,ppid=,comm=', DISCOVERY_OPTIONS);
        const processes = new Map();
        for (const line of stdout.split('\n')) {
            const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
            if (!match) continue;
            processes.set(match[1], { ppid: match[2], command: match[3] });
        }
        return processes;
    } catch {
        return undefined;
    }
}

function shellAncestors(pid, processes) {
    const ancestors = [];
    let current = String(pid);
    const seen = new Set([current]);

    while (true) {
        const process = processes.get(current);
        if (!process || !process.ppid || process.ppid === '1' || seen.has(process.ppid)) break;

        const parent = processes.get(process.ppid);
        if (!parent || !isShellLikeProcess(parent.command)) break;

        ancestors.push(process.ppid);
        seen.add(process.ppid);
        current = process.ppid;
    }

    return ancestors;
}

function isShellLikeProcess(command) {
    const name = String(command || '').trim().split('/').pop();
    return [
        'bash',
        'dash',
        'env',
        'fish',
        'ksh',
        'sh',
        'tmux',
        'tmux: client',
        'zsh',
    ].includes(name);
}

function agentSessionParts(session) {
    let match = String(session || '').match(new RegExp(`^(${AGENT_PROGRAM_PATTERN})-(.+)-([0-9]{8}_[0-9]{6})$`));
    if (match) return { program: match[1], title: match[2], stamp: match[3] };

    match = String(session || '').match(new RegExp(`^(${AGENT_PROGRAM_PATTERN})-([0-9]{8}_[0-9]{6})-(.+)$`));
    if (match) return { program: match[1], title: match[3], stamp: match[2] };

    match = String(session || '').match(new RegExp(`^(${AGENT_PROGRAM_PATTERN})-(.+)$`));
    if (match) return { program: match[1], title: match[2], stamp: '' };

    match = String(session || '').match(new RegExp(`^(${AGENT_PROGRAM_PATTERN})$`));
    if (match) return { program: match[1], title: match[1], stamp: '' };

    return undefined;
}

function isAgentSession(session) {
    return Boolean(agentSessionParts(session));
}

function nameFromSession(session) {
    return agentSessionParts(session)?.title || session;
}

function normalizeName(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/[^a-z0-9.-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function isPersistableTitle(value) {
    const raw = String(value || '').trim().toLowerCase();
    const clean = normalizeName(raw);
    const sessionLike = new RegExp(`^(${AGENT_PROGRAM_PATTERN})-.+-[0-9]{8}[_-][0-9]{6}$`);
    return Boolean(clean)
        && !GENERIC_TERMINAL_NAMES.has(clean)
        && !sessionLike.test(raw)
        && !clean.endsWith('agent-tmux-attach-zsh');
}

function isGeneratedName(value) {
    const clean = normalizeName(value);
    const parts = clean.split('-');
    if (parts.length !== 2 && !(parts.length === 3 && /^\d{6}$/.test(parts[2]))) {
        return false;
    }
    return GENERATED_ADJECTIVES.has(parts[0]) && GENERATED_NOUNS.has(parts[1]);
}

function authoritativeTitle(item) {
    return normalizeName(item?.userNamed || item?.title || nameFromSession(item?.session));
}

function attachmentIdentity(terminal) {
    const options = terminal.creationOptions;
    // An inherited environment variable in an ordinary shell is not evidence
    // that this tab was created by our attach helper.
    if (typeof options?.shellPath !== 'string' || path.basename(options.shellPath) !== 'agent-tmux-attach.zsh') return;
    const token = options.env?.[ATTACHMENT_ENV];
    return validToken(token) ? attachments.get(token) : undefined;
}

function rememberAttachments(items) {
    const tokens = new Map();
    const next = new Map(attachments);
    for (const item of items) {
        if (!validIdentity(item.identity)) continue;
        const token = require('crypto').randomUUID();
        next.set(token, item.identity);
        tokens.set(item.session, token);
    }
    if (!tokens.size) return tokens;
    while (next.size > MAX_ATTACHMENTS) next.delete(next.keys().next().value);
    attachments = next;
    try {
        // One background write per batch, never another startup dependency.
        // If it fails or a reload races it, missing tokens use PID discovery.
        void Promise.resolve(attachmentState.update(ATTACHMENTS_KEY, [...next]))
            .catch(error => warn('attachmentCache', error));
    } catch (error) { warn('attachmentCache', error); }
    return tokens;
}

function observeTerminalPid(terminal) {
    let record = terminalPids.get(terminal);
    if (record) return record;
    record = { pending: true, waited: false };
    terminalPids.set(terminal, record);
    // Subscribe once, without putting this terminal's promise on the shared
    // operation queue. Resolution schedules a fresh client snapshot if needed.
    Promise.resolve().then(() => terminal.processId).then(pid => {
        record.pid = pid; record.pending = false;
        if (record.waited && vscode.window.terminals.includes(terminal)) {
            void schedule('attachPoll', () => attachSessions({ quiet: true }));
        }
    }, () => { record.pending = false; record.failed = true; });
    return record;
}

function terminalSessionFromPid(terminal, pid, clientSessionsByPid, liveSessionNames, liveByIdentity) {
    const session = clientSessionsByPid.get(String(pid));
    if (session && liveSessionNames.has(session)) return session;

    const identity = terminalSessionIdentities.get(terminal);
    if (identity) return liveByIdentity.get(identity)?.session;

    // Launch metadata is only a shortcut while VS Code has not supplied a PID.
    // Once it does, the live client/process relationship takes precedence.
    if (pid === undefined) {
        const saved = attachmentIdentity(terminal);
        if (saved && liveByIdentity.has(saved)) return liveByIdentity.get(saved).session;
    }

    const tracked = terminalSessions.get(terminal);
    if (tracked && liveSessionNames.has(tracked)) {
        return tracked;
    }

    return undefined;
}

async function refreshTerminalMappings() {
    const report = firstDiscovery;
    firstDiscovery = false;
    const terminals = [...vscode.window.terminals];
    terminals.forEach(observeTerminalPid);
    const sessions = await getAgentSessions();
    if (report) startupLog('session query', `ok=${Boolean(sessions)} tabs=${terminals.length}`);
    if (!sessions) return { complete: false, terminals };
    const liveBySession = new Map(sessions.map(item => [item.session, item]));
    const liveSessionNames = new Set(liveBySession.keys());
    const liveByIdentity = new Map(sessions.filter(item => item.identity).map(item => [item.identity, item]));
    const snapshotPids = new Map(terminals.map(terminal => [terminal, terminalPids.get(terminal).pid]));
    // Without any ready PIDs there is nothing to join against the process
    // table. Validate saved identities now; resolution triggers a fresh pass.
    const clientSessionsByPid = [...snapshotPids.values()].some(pid => pid !== undefined)
        ? await getTmuxClientSessionsByPid() : new Map();
    if (report) startupLog('client query', `ok=${Boolean(clientSessionsByPid)}`);
    if (!clientSessionsByPid) return { complete: false, terminals };
    const currentTerminals = new Set(vscode.window.terminals);

    const rebuiltTerminals = new Map();

    for (const terminal of terminals) {
        if (!currentTerminals.has(terminal)) continue;
        if (!terminalNames.has(terminal)) {
            terminalNames.set(terminal, normalizeName(terminal.name));
        }

        const session = terminalSessionFromPid(terminal, snapshotPids.get(terminal), clientSessionsByPid, liveSessionNames, liveByIdentity);
        if (!session) {
            terminalSessions.delete(terminal);
            continue;
        }

        const live = liveBySession.get(session);
        // A tab may still display its generated startup name. Never close it
        // to refresh a label: it can be the user's launcher or only live client.
        terminalSessions.set(terminal, session);
        if (live?.identity) terminalSessionIdentities.set(terminal, live.identity);
        addSessionTerminal(session, terminal, rebuiltTerminals);
    }

    for (const terminal of [...terminalSessions.keys()]) {
        if (!currentTerminals.has(terminal)) {
            terminalSessions.delete(terminal);
        }
    }
    for (const terminal of [...terminalSessionIdentities.keys()]) {
        if (!currentTerminals.has(terminal)) terminalSessionIdentities.delete(terminal);
    }
    for (const terminal of [...terminalNames.keys()]) {
        if (!currentTerminals.has(terminal)) {
            terminalNames.delete(terminal);
        }
    }

    for (const item of sessions) {
        if (!lastKnownNames.has(item.session)) {
            lastKnownNames.set(item.session, authoritativeTitle(item));
        }
    }
    for (const session of [...lastKnownNames.keys()]) {
        if (!liveSessionNames.has(session)) {
            lastKnownNames.delete(session);
        }
    }

    sessionTerminals = rebuiltTerminals;
    const unresolved = terminals.some(terminal => {
        const record = terminalPids.get(terminal);
        if (record.pending) record.waited = true;
        return currentTerminals.has(terminal) && !terminalSessions.has(terminal)
            && !terminal.creationOptions?.hideFromUser && !terminal.creationOptions?.pty
            && (record.pending || record.failed || record.pid !== snapshotPids.get(terminal));
    });
    if (report) startupLog('mapping', `mapped=${terminalSessions.size} pending=${unresolved}`);
    return { complete: true, unresolved, sessions, liveBySession, liveSessionNames, terminals };
}

function addSessionTerminal(session, terminal, target = sessionTerminals) {
    let terminals = target.get(session);
    if (!terminals) {
        terminals = new Set();
        target.set(session, terminals);
    }
    terminals.add(terminal);
}

function sessionRepresented(session) {
    return (sessionTerminals.get(session)?.size || 0) > 0;
}

async function renameSession(session, title) {
    try {
        const clean = normalizeName(title);
        const { stdout: currentPath } = await execFileAsync('tmux', ['display-message', '-p', '-t', '=' + session, '#{pane_current_path}']);
        const { stdout } = await execFileAsync(
            RENAME_SCRIPT,
            [session, clean, currentPath.trim(), 'rename', ''],
            { cwd: SCRIPT_ROOT, env: { ...process.env, AGENT_GLUE_WORKSPACE: SCRIPT_ROOT, AGENT_GLUE_TASKS_FILE: taskOutput } }
        );
        return stdout.trim().split(/\r?\n/).filter(Boolean).pop() || session;
    } catch (error) {
        warn(`rename ${session}`, error);
        return undefined;
    }
}

function moveSessionMapping(oldSession, newSession, title) {
    const clean = normalizeName(title);
    const terminals = sessionTerminals.get(oldSession) || new Set();
    sessionTerminals.delete(oldSession);

    let targetTerminals = sessionTerminals.get(newSession);
    if (!targetTerminals) {
        targetTerminals = new Set();
        sessionTerminals.set(newSession, targetTerminals);
    }

    for (const terminal of terminals) {
        terminalSessions.set(terminal, newSession);
        targetTerminals.add(terminal);
    }

    lastKnownNames.delete(oldSession);
    lastKnownNames.set(newSession, clean);
}

async function persistTerminalRename(sourceTerminal) {
    const terminal = sourceTerminal || vscode.window.activeTerminal;
    if (!terminal || !vscode.window.terminals.includes(terminal)) return;
    if (terminalNames.get(terminal) === normalizeName(terminal.name)) return;
    const { complete, liveBySession } = await refreshTerminalMappings();
    if (!complete || !vscode.window.terminals.includes(terminal)) return;

    const current = normalizeName(terminal.name);
    const observed = terminalNames.get(terminal);
    if (observed === undefined) {
        terminalNames.set(terminal, current);
        return;
    }
    if (current === observed) return;

    terminalNames.set(terminal, current);

    const session = terminalSessions.get(terminal);
    if (!session) return;

    const live = liveBySession.get(session);
    if (!live) return;

    const liveTitle = authoritativeTitle(live);
    const userNamed = normalizeName(live.userNamed);
    const previousTitle = lastKnownNames.get(session) || liveTitle;
    if (!isPersistableTitle(terminal.name) || current === liveTitle || current === previousTitle) {
        return;
    }
    if (userNamed && isGeneratedName(current)) {
        terminalNames.set(terminal, current);
        return;
    }
    if (isGeneratedName(current) && !isGeneratedName(liveTitle)) {
        terminalNames.set(terminal, current);
        return;
    }

    const renamedSession = await renameSession(session, current);
    if (!renamedSession) {
        terminalNames.set(terminal, liveTitle);
        return;
    }

    moveSessionMapping(session, renamedSession, current);
}

async function attachSessions({ quiet = false, force = false } = {}) {
    const { complete, unresolved, sessions, terminals } = await refreshTerminalMappings();
    if (!complete) return;
    // Known terminals remain mapped and usable. An unknown pending native tab
    // could be a launcher for any unmatched session; never create a duplicate
    // merely because its PID has not arrived (including an explicit refresh).
    if (unresolved) {
        if (!quiet) vscode.window.showInformationMessage('A terminal is still starting; existing sessions remain connected. Try Attach again when it is ready.');
        return;
    }
    // A terminal opened during discovery may be the launcher. Let the next
    // poll include it before deciding that another attachment is needed.
    if (vscode.window.terminals.some(terminal => !terminals.includes(terminal))) return;
    let attached = 0;

    const candidates = [];
    for (const item of sessions) {
        if (sessionRepresented(item.session)) continue;
        // Launchers set their title before metadata/task sync and tmux attach.
        // That work can exceed the grace period. An unmapped matching tab is
        // evidence to defer auto-attach, not enough to claim session identity.
        const labels = new Set([item.title, item.userNamed, nameFromSession(item.session), item.session].filter(Boolean).map(normalizeName));
        if (!force && vscode.window.terminals.some(terminal => !terminalSessions.has(terminal)
            && isPersistableTitle(terminal.name) && labels.has(normalizeName(terminal.name)))) continue;
        if (item.created > 0 && Date.now() - item.created * 1000 < NEW_SESSION_GRACE_MS) continue;
        candidates.push(item);
    }
    const tokens = rememberAttachments(candidates);
    for (const item of candidates) {
        const token = tokens.get(item.session);
        const name = item.title || nameFromSession(item.session);
        const terminal = vscode.window.createTerminal({
            name,
            shellPath: ATTACH_SCRIPT,
            shellArgs: [item.session, name],
            // This is a tmux client, not a new project shell. Freeze its launcher
            // environment so Python/other extensions cannot request reinjection.
            strictEnv: true,
            env: { ...process.env, AGENT_GLUE_WORKSPACE: SCRIPT_ROOT, AGENT_GLUE_TASKS_FILE: taskOutput, [ATTACHMENT_ENV]: token || null },
            cwd: SCRIPT_ROOT,
        });

        terminalSessions.set(terminal, item.session);
        if (item.identity) terminalSessionIdentities.set(terminal, item.identity);
        terminalNames.set(terminal, normalizeName(name));
        addSessionTerminal(item.session, terminal);
        lastKnownNames.set(item.session, authoritativeTitle(item));
        attached++;
    }

    if (!quiet) {
        if (attached > 0) {
            vscode.window.showInformationMessage(
                `Attached ${attached} tmux session${attached !== 1 ? 's' : ''}`
            );
        } else {
            vscode.window.showInformationMessage('No new agent tmux sessions to attach');
        }
    }
}

function forgetTerminal(terminal) {
    terminalSessionIdentities.delete(terminal);
    const session = terminalSessions.get(terminal);
    terminalSessions.delete(terminal);
    terminalNames.delete(terminal);
    if (sessionTerminals.has(session)) {
        sessionTerminals.get(session).delete(terminal);
    }
}

function activate(context) {
    if (!vscode.workspace.isTrusted) return;
    if (vscode.extensions.all.some(extension => extension.packageJSON?.name === 'tmux-claude-attach')) {
        vscode.window.showWarningMessage('Disable the original Tmux Claude/Codex Attach extension before enabling Agent Glue Sessions.');
        return;
    }
    activatedAt = Date.now();
    startupLog('activated');
    attachmentState = context.globalState;
    const savedAttachments = attachmentState.get?.(ATTACHMENTS_KEY);
    attachments = new Map((Array.isArray(savedAttachments) ? savedAttachments.slice(-MAX_ATTACHMENTS) : [])
        .filter(row => Array.isArray(row) && row.length === 2 && validToken(row[0]) && validIdentity(row[1])));
    taskOutput = path.join(context.globalStorageUri.fsPath, 'tasks-' + require('crypto').createHash('sha256').update(SCRIPT_ROOT).digest('hex').slice(0,16) + '.json');
    context.subscriptions.push(vscode.tasks.registerTaskProvider('agentGlue.session', {
        async provideTasks() {
            await execFileAsync(path.join(__dirname, 'helpers', 'sync-agent-tmux-tasks.zsh'), [], { cwd: SCRIPT_ROOT, env: { ...process.env, AGENT_GLUE_WORKSPACE: SCRIPT_ROOT, AGENT_GLUE_TASKS_FILE: taskOutput } });
            const generated = JSON.parse(await fs.promises.readFile(taskOutput, 'utf8'));
            return generated.tasks.map(item => {
                const task = new vscode.Task({ type: 'agentGlue.session', session: item.detail }, vscode.TaskScope.Workspace, item.label, 'Agent Glue', new vscode.ProcessExecution(item.command, item.args, { cwd: SCRIPT_ROOT, env: { AGENT_GLUE_WORKSPACE: SCRIPT_ROOT, AGENT_GLUE_TASKS_FILE: taskOutput } }));
                task.presentationOptions = item.presentation;
                return task;
            });
        },
        resolveTask() { return undefined; }
    }));

    context.subscriptions.push(
        vscode.commands.registerCommand('tmuxClaude.attachAll', () => {
            void schedule('attachAll', () => attachSessions({ quiet: false, force: true }));
        }),
        vscode.window.onDidChangeTerminalState((terminal) => {
            // Restore emits state changes even when no name changed. Opening
            // tabs and PID resolution have their own discovery events; avoid
            // another full scan here while preserving actual rename operations.
            if (terminalNames.get(terminal) === normalizeName(terminal.name)) return;
            void schedule('terminalState', () => persistTerminalRename(terminal));
        }),
        vscode.window.onDidCloseTerminal((terminal) => {
            forgetTerminal(terminal);
        }),
        vscode.window.onDidOpenTerminal((terminal) => {
            observeTerminalPid(terminal);
            void schedule('attachPoll', () => attachSessions({ quiet: true }));
        })
    );

    void schedule('startup', async () => {
        await attachSessions({ quiet: true });
        startupLog('initial pass finished', `mapped=${terminalSessions.size}`);
    });

    const renamePoll = setInterval(() => {
        void schedule('renamePoll', () => persistTerminalRename(vscode.window.activeTerminal));
    }, RENAME_POLL_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(renamePoll) });

    const attachPoll = setInterval(() => {
        void schedule('attachPoll', () => attachSessions({ quiet: true }));
    }, ATTACH_POLL_INTERVAL_MS);
    context.subscriptions.push({ dispose: () => clearInterval(attachPoll) });
    return { handoffProfiles: [...AGENT_PROGRAMS], forkSession: (source,destination,options) => {
        const result=operationQueue.catch(()=>{}).then(()=>require('./fork.cjs').forkSession(source,destination,{exec:execFileAsync,createTerminal:options=>vscode.window.createTerminal(options),register:(session,terminal)=>{terminalSessions.set(terminal,session);addSessionTerminal(session,terminal);},handoffDirectory:path.join(context.globalStorageUri.fsPath,'handoffs')},options));
        operationQueue=result.catch(error=>warn('fork',error));return result;
    }, terminalForSession: session => [...(sessionTerminals.get(session) || [])].find(t => vscode.window.terminals.includes(t)), sessionForTerminal: terminal => terminalSessions.get(terminal), refresh: () => schedule('apiRefresh', () => attachSessions({ quiet: true })) };
}

function deactivate() {}

module.exports = { activate, deactivate };
