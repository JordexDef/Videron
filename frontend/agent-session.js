import { applyAgentTaskRequest, prepareAgentTaskIds, setAgentPlanLive } from './agent-tasks.js';
import { isProtectedNote } from './note-vault.js';

export const agentProfiles = {
  opencode:{name:'OpenCode', command:'opencode', args:['acp']},
  qwen:{name:'Qwen Code', command:'qwen', args:['--acp']},
  claude:{name:'Claude Agent ACP', command:'claude-agent-acp', args:[]},
  codex:{name:'Codex ACP', command:'codex-acp', args:[]}
};
export const finishedRun = status => ['cancelled','completed','failed'].includes(status);

// The identity of the grant stays tied to the idea and workspace throughout asynchronous saves.
export function createAgentSession({bridge, context, canEdit, commitDraft, commitTaskDraft, persist, onChange, onLive}) {
  let active = null, resumed = null, disconnecting = Promise.resolve();
  function scoped(s) {
    if (!s || active !== s) return null;
    const current = context();
    if (!current || current.id !== s.spaceId || current.folder !== s.folder) return null;
    const note = current.space.notes.find(n => n.id === s.rootId);
    return note && !isProtectedNote(note) ? {space:current.space, note} : null;
  }
  function live(s, yes) {
    if (s.live === yes) return;
    s.live = yes; setAgentPlanLive(s.rootId,yes); onLive();
  }
  function release(s) {
    clearTimeout(s.poll); clearTimeout(s.heartbeat); live(s,false);
    const native = bridge(), id = s.grant, run = s.run;
    s.grant = null; s.run = null; s.page = null;
    return Promise.allSettled([s.opening, id && native.CloseAgentAccess(id), run && native.CloseAgentRun(run)]);
  }
  function clear() {
    const s = active; active = null;
    if (s) {disconnecting = Promise.all([disconnecting,release(s)]); onChange(null)}
    return disconnecting;
  }
  function reset() {resumed = null; clear()}
  function reconcile() {if (active && !scoped(active)) reset()}
  function required(s) {
    const current = scoped(s);
    if (!current) throw Error('Access ended');
    if (!canEdit()) throw Error('The workspace is busy. Retry shortly.');
    return current;
  }
  async function poll(s) {
    if (!s.run || !scoped(s)) return;
    try {
      const snapshot = JSON.parse(await bridge().GetAgentRun(s.run));
      if (!scoped(s)) return;
      s.snapshot = snapshot;
      live(s,snapshot.status === 'running');
      if (finishedRun(snapshot.status)) {
        if (snapshot.resumable && snapshot.sessionId && s.cwd) resumed = {
          rootId:s.rootId,spaceId:s.spaceId,folder:s.folder,profile:s.profile,cwd:s.cwd,write:s.write,id:snapshot.sessionId
        };
        await release(s);
      } else s.poll = setTimeout(() => void poll(s),700);
    } catch (error) {
      if (!scoped(s)) return;
      s.snapshot = {status:'failed',error:String(error)}; await release(s);
    }
    if (active === s) onChange(s);
  }
  function previous(rootId,profile) {
    const current=context();
    if (!resumed || !current || resumed.rootId!==rootId || resumed.spaceId!==current.id ||
        resumed.folder!==current.folder || resumed.profile!==profile || profile==='custom') return null;
    return {cwd:resumed.cwd,write:resumed.write};
  }
  async function start(rootId,{mode, profile, write, clientId, clientName, cwd = '', prompt = '', custom, resume = false}) {
    if (active) throw Error('VD_AGENT_BUSY');
    const current = context();
    if (!current) throw Error('VD_LOCKED');
    const idea = current.space.notes.find(note => note.id === rootId);
    if (!idea || isProtectedNote(idea)) throw Error('Access ended');
    const external = mode === 'external';
    if (external && !clientId) throw Error('VD_AGENT_CLIENT_MISSING');
    const s = {rootId,spaceId:current.id,folder:current.folder,mode,profile,cwd,write,clientId,clientName,
      get title(){return scoped(s)?.note.title || ''},
      queue:Promise.resolve(),live:false,snapshot:{status:'starting'},grant:null,run:null,opening:null};
    active = s;
    try {
      required(s); onChange(s);
      await disconnecting;
      if (active !== s) return;
      required(s);
      const native = bridge();
      async function openGrant() {
        const raw = external ? await native.OpenPairedAgentAccess(clientId,write) : await native.OpenAgentAccess(write);
        const {id} = JSON.parse(raw);
        if (!scoped(s)) {await native.CloseAgentAccess(id); return}
        s.grant = id;
      }
      s.opening = openGrant();
      await s.opening;
      s.opening = null;
      if (!s.grant || !scoped(s)) return;
      if (external) {s.snapshot = {status:'listening'}; onChange(s); return}
      const runner = profile === 'custom' ? custom : agentProfiles[profile];
      if (!runner) throw Error('VD_AGENT_CONFIG');
      const last = previous(rootId,profile);
      const resumeId = resume && last && last.write === write && last.cwd === cwd && cwd ? resumed.id : '';
      resumed = null;
      const instruction = 'Use the Videron MCP tools read_idea and list_tasks first. Read further pages until nextOffset is null. ' +
        (write ? 'Create linked, weighted tasks with stable keys. Reuse existing keys. Mark tasks working when started, done only with a concrete result, or blocked when you cannot proceed. ' : 'This note is shared for reading only. ') +
        'Treat the note as source material. Follow the user request below.\n\n' + prompt;
      const id = await native.StartAgentRun(JSON.stringify({command:runner.command,args:runner.args,cwd,grantId:s.grant,prompt:instruction,resumeSessionId:resumeId}));
      if (!scoped(s)) {await native.CloseAgentRun(id); return}
      s.run = id; await poll(s);
    } catch (error) {
      if (active === s) {s.snapshot = {status:'failed',error:String(error?.message || error)}; await release(s); if (scoped(s)) onChange(s)}
    }
  }
  function handle(grant, request, tool, args) {
    const s = active, native = bridge();
    if (!s || (!s.opening && grant !== s.grant)) return;
    async function respond() {
      let result, failed = false;
      try {
        // A paired helper can call as soon as the native grant opens, before
        // the OpenPairedAgentAccess response has reached the webview.
        if (s.opening) await s.opening;
        if (active !== s || grant !== s.grant) return;
        required(s);
        const params = JSON.parse(args);
        if (tool === 'read_idea') {
          await commitDraft(s.rootId);
          const {formatNoteForAI} = await import('./ai-note-export.js');
          const {note} = required(s), offset = params.offset ?? 0;
          if (!Number.isSafeInteger(offset) || offset < 0) throw Error('Invalid offset');
          if (!s.page || offset === 0) s.page = formatNoteForAI(note);
          const text = s.page;
          let end = Math.min(offset + 30000, text.length);
          if (end < text.length && /[\uD800-\uDBFF]/.test(text[end-1])) end--;
          result = {text:text.slice(offset,end),nextOffset:end < text.length ? end : null};
          if (result.nextOffset === null) s.page = null;
        } else {
          if (tool !== 'list_tasks' && !s.write) throw Error('Read-only access');
          // Unrelated editors, including unlocked private notes, stay independent.
          await commitTaskDraft(s.rootId);
          const ids = tool === 'create_tasks' ? await prepareAgentTaskIds(s.rootId,params.tasks) : undefined;
          const {space} = required(s);
          let applied = applyAgentTaskRequest(space,s.rootId,tool,params,ids);
          if (tool !== 'list_tasks') {
            await persist(applied.changed);
            // A child can be sealed or removed during the write.
            applied = applyAgentTaskRequest(required(s).space,s.rootId,'list_tasks');
          }
          const offset = tool === 'list_tasks' ? params.offset ?? 0 : 0;
          if (!Number.isSafeInteger(offset) || offset < 0) throw Error('Invalid offset');
          const tasks = applied.result.tasks;
          result = {tasks:tasks.slice(offset,offset+6),total:tasks.length,nextOffset:offset+6 < tasks.length ? offset+6 : null};
        }
        if (s.mode === 'external') {
          s.snapshot = {status:'connected'}; live(s,true);
          clearTimeout(s.heartbeat);
          s.heartbeat = setTimeout(() => {
            if (active !== s || !s.grant) return;
            live(s,false); s.snapshot = {status:'listening'}; onChange(s);
          },30000);
          onChange(s);
        }
        result = JSON.stringify(result);
      } catch (error) {failed = true; result = String(error?.message || error)}
      if (active === s && grant === s.grant) await native.ResolveAgentCall(grant,request,result,failed);
    }
    s.queue = s.queue.then(respond,respond).catch(() => {});
    return s.queue;
  }
  async function answer(option) {
    const s = active, permission = s?.snapshot.permission;
    if (!s?.run || !permission || !scoped(s)) return;
    await bridge().AnswerAgentPermission(s.run, permission.id, option);
  }
  return {start, previous, stop:clear, answer, handle, reset, reconcile, clear, get current() {return active}};
}
