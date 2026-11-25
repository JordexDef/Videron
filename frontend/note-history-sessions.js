// Plain undo stacks stay in the WebView during navigation. The desktop seals
// protected stacks and holds ordinary stacks across a full-lock WebView reload.
export class NoteHistorySessions {
  #spaces = new Map()
  constructor(bridge) { this.bridge=bridge }

  async open(ref) {
    let notes=this.#spaces.get(ref.space)
    if(!notes){notes=new Map();this.#spaces.set(ref.space,notes)}
    const previous=notes.get(ref.note)
    const entry={ref}
    notes.set(ref.note,entry)
    if(previous && previous.ref.kind===ref.kind && previous.ref.folder===ref.folder &&
        previous.ref.protection===ref.protection && ref.protection==='plain'){
      entry.snapshot=previous.snapshot
    }
    let restored
    let hasNative=false
    if(entry.snapshot===undefined && this.bridge?.ReadEditorHistory){
      const raw=await this.bridge.ReadEditorHistory(ref)
      if(raw){restored=JSON.parse(raw);hasNative=true}
    }
    return {
      take:()=>{
        if(notes.get(ref.note)!==entry)return
        const snapshot=entry.snapshot ?? restored
        delete entry.snapshot
        restored=undefined
        return snapshot
      },
      save:async snapshot=>{
        if(notes.get(ref.note)!==entry)return
        if(snapshot===undefined || ref.protection==='plain'){
          if(hasNative){
            await this.bridge.ForgetEditorHistories(ref.space,[ref.note])
            hasNative=false
          }
          // Releasing a vault key or writing the note can still fail after this
          // checkpoint. The same editor may remain open, gain edits and retry.
          entry.snapshot=snapshot
        }else if(this.bridge?.StoreEditorHistory){
          await this.bridge.StoreEditorHistory(ref,JSON.stringify(snapshot))
          hasNative=true
        }
      }
    }
  }

  async forget(space,ids) {
    const notes=this.#spaces.get(space)
    if(!space){
      for(const existing of this.#spaces.values())existing.clear()
      this.#spaces.clear()
    }else if(ids?.length){
      for(const id of ids)notes?.delete(id)
    }else{
      notes?.clear();this.#spaces.delete(space)
    }
    await this.bridge?.ForgetEditorHistories?.(space,ids??[])
  }

  async reconcile(space,records,describe) {
    const known=this.#spaces.get(space)
    if(!known?.size)return
    const stale=new Set(known.keys())
    for(const record of records){
      const ref=known.get(record.id)?.ref
      if(!ref)continue
      const live=describe(record)
      if(ref.folder===live.folder && ref.protection===live.protection &&
          (live.protection==='note' || ref.kind===live.kind))stale.delete(record.id)
      if(!stale.size)break
    }
    if(stale.size)await this.forget(space,[...stale])
  }

  async parkForLock() {
    if(!this.bridge?.StoreEditorHistory)return
    for(const notes of this.#spaces.values())for(const entry of notes.values()){
      if(entry.snapshot===undefined)continue
      await this.bridge.StoreEditorHistory(entry.ref,JSON.stringify(entry.snapshot))
      delete entry.snapshot
    }
  }
}
