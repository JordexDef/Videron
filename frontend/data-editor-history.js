import {ChangeSet, EditorSelection, EditorState, StateEffect, StateField, Transaction, history, historyField,
  invertedEffects, isolateHistory, redo, redoDepth, undo, undoDepth} from './vendor/codemirror/editor-core.js'
import {lineEndingSupport, lineEndingState, lineEndings, restoreLineEndings} from './data-line-endings.js'
import {textDocument} from './data-document.js'

const setTitle = StateEffect.define()
const titleField = StateField.define({
  create:()=>'',
  update(title,tr){ for (const effect of tr.effects) if (effect.is(setTitle)) title=effect.value; return title }
})
export const dataTitle = state => state.field(titleField,false) ?? ''
export const changeDataTitle = title => setTitle.of(title)
export const dataTitleSupport = title => [titleField.init(()=>title),
  invertedEffects.of(tr=>tr.effects.some(e=>e.is(setTitle)) ? [setTitle.of(dataTitle(tr.startState))] : [])]

function endingChange(before,after) {
  const old = lineEndings(before), next = lineEndings(after)
  return old.preferred !== next.preferred || old.codes !== next.codes ? next : undefined
}
function titleChange(before,after) {
  return dataTitle(before) === dataTitle(after) ? undefined : dataTitle(after)
}
function stepEffects(endings,title) {
  const effects=[]
  if (endings) effects.push(restoreLineEndings(endings))
  if (title !== undefined) effects.push(setTitle.of(title))
  return effects
}

// Walk CodeMirror's grouped operations on immutable states. Save only changed
// spans, cursor selections and the separator metadata changed by imports or sorts.
// This also retains effects that CodeMirror's built-in history JSON drops.
function captureBranch(state,command) {
  const steps = []
  const target = {state, dispatch(tr) {
    steps.push({changes:tr.changes.toJSON(), selection:tr.state.selection.toJSON(),
      endings:endingChange(target.state,tr.state),title:titleChange(target.state,tr.state)})
    target.state = tr.state
  }}
  while (command(target)) { /* advance the detached cursor */ }
  return steps
}
export function captureDataHistory(state,source) {
  if (!undoDepth(state) && !redoDepth(state)) return undefined
  const detached = EditorState.create({doc:state.doc,selection:state.selection,extensions:[
    historyField.init(() => state.field(historyField)),history(),lineEndingState(lineEndings(state)),dataTitleSupport(dataTitle(state))
  ]})
  return {source,title:dataTitle(state),selection:state.selection.toJSON(),past:captureBranch(detached,undo),future:captureBranch(detached,redo)}
}

function textDifference(before,after) {
  // One splice deliberately spans all disjoint remote edits: history in the
  // uncertain middle is dropped rather than guessing which occurrence moved.
  before = before.replace(/\r\n?/g,'\n'); after = after.replace(/\r\n?/g,'\n')
  const shortest=Math.min(before.length,after.length)
  let prefix=0,suffix=0
  while (prefix<shortest && before.charCodeAt(prefix)===after.charCodeAt(prefix)) prefix++
  while (suffix<shortest && before.charCodeAt(before.length-1-suffix)===after.charCodeAt(after.length-1-suffix)) suffix++
  // Both alignments of a deletion in repeated text look identical. Treat the
  // entire ambiguous run as changed so Undo cannot remove the surviving copy.
  let from=Math.min(prefix,shortest-suffix), tail=Math.min(suffix,shortest-prefix)
  const splitsPair=(s,pos)=>s.charCodeAt(pos-1)>=0xd800 && s.charCodeAt(pos-1)<=0xdbff &&
    s.charCodeAt(pos)>=0xdc00 && s.charCodeAt(pos)<=0xdfff
  if (splitsPair(before,from) || splitsPair(after,from)) from--
  if (splitsPair(before,before.length-tail) || splitsPair(after,after.length-tail)) tail--
  return {from,to:before.length-tail,insert:after.slice(from,after.length-tail)}
}
function decodeBranch(steps,remote,peerTitle) {
  const result = []
  for (const step of steps) {
    if (peerTitle && step.title!==undefined) break
    const changes = ChangeSet.fromJSON(step.changes)
    if (remote) {
      // A full-file separator snapshot cannot safely describe a peer's text.
      if (step.endings) break
      let overlaps = false
      changes.iterChangedRanges((localFrom,localTo) => {
        remote.iterChangedRanges((peerFrom,peerTo) => {
          if (localFrom === localTo && peerFrom === peerTo) overlaps ||= localFrom === peerFrom
          else if (localFrom === localTo) overlaps ||= peerFrom <= localFrom && localFrom <= peerTo
          else if (peerFrom === peerTo) overlaps ||= localFrom < peerFrom && peerFrom < localTo
          else overlaps ||= localFrom < peerTo && peerFrom < localTo
        })
      })
      if (overlaps) break
      remote = remote.mapDesc(changes.desc,true)
    }
    result.push({changes,selection:EditorSelection.fromJSON(step.selection),effects:stepEffects(step.endings,step.title)})
  }
  return result
}
const separate = isolateHistory.of('full')
const noHistory = Transaction.addToHistory.of(false)
export function restoreDataHistory(saved,source,title='') {
  if (!saved) return null
  let state = EditorState.create({doc:textDocument(saved.source),selection:EditorSelection.fromJSON(saved.selection),
    extensions:[history(),lineEndingSupport(saved.source),dataTitleSupport(saved.title)]})
  let remote
  if (source !== saved.source) {
    // Mixed files can contain position-specific line endings in existing undo
    // events, even when the corresponding logical text change is disjoint.
    const current = EditorState.create({extensions:lineEndingSupport(source)})
    const old = lineEndings(state), next = lineEndings(current)
    if (old.codes || next.codes || old.preferred !== next.preferred) return null
    remote = state.changes(textDifference(saved.source,source))
  }
  const peerTitle=saved.title!==title
  const past = decodeBranch(saved.past,remote?.desc,peerTitle), future = decodeBranch(saved.future,remote?.desc,peerTitle)
  if (!past.length && !future.length) return null
  const forward = []
  for (const step of past) {
    const next = state.update({...step,annotations:noHistory}).state
    forward.push({changes:step.changes.invert(state.doc),selection:state.selection,
      effects:stepEffects(endingChange(next,state),titleChange(next,state))})
    state = next
  }
  // Rebuild native history boundaries with ordinary transactions, including
  // pending redo events, so text and grid shortcuts still share one history.
  for (let i=forward.length-1;i>=0;i--) state=state.update({...forward[i],annotations:separate}).state
  for (const step of future) state=state.update({...step,annotations:separate}).state
  const target = {state,dispatch:tr=>{target.state=tr.state}}
  for (let i=0;i<future.length;i++) undo(target)
  state=target.state.update({selection:EditorSelection.fromJSON(saved.selection),annotations:noHistory}).state
  return remote || peerTitle ? state.update({changes:remote,effects:peerTitle ? setTitle.of(title) : [],annotations:noHistory}).state : state
}
