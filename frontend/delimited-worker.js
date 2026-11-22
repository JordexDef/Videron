import {createDelimitedIndex} from './delimited-engine.js';

function serveDelimited(createIndex) {
  let table, separator, proposed;
  self.onmessage = ({data}) => {
    try {
      let result;
      switch (data.kind) {
        case 'open':
          separator = data.separator;
          table = createIndex(data.text,separator);
          result = {rowCount:table.rowCount,columnCount:table.columnCount};
          break;
        case 'read': result = table.read(...data.args); break;
        case 'cellRange': result = table.cellRange(...data.args); break;
        case 'transform':
          result = table.transform(data.operation);
          proposed = result.text;
          break;
        case 'commit':
          if (typeof proposed !== 'string') throw new Error('No table change to commit');
          table = createIndex(proposed,separator);
          proposed = null;
          result = {rowCount:table.rowCount,columnCount:table.columnCount};
          break;
        default: throw new Error('Unknown table request');
      }
      self.postMessage({id:data.id,result});
    } catch (error) {
      self.postMessage({id:data.id,error:{message:error.message,code:error.code,row:error.row,offset:error.offset}});
    }
  };
  self.postMessage({boot:true});
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) serveDelimited(createDelimitedIndex);

export function openDelimitedSession(text, separator) {
  let worker, blobURL, startupTimer, closed = false, nextId = 1;
  const pending = new Map();
  function stopWorker() {
    clearTimeout(startupTimer);
    if (worker) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate(); worker = null;
    }
    if (blobURL) {URL.revokeObjectURL(blobURL); blobURL = null;}
  }
  function close(error = new DOMException('Closed','AbortError')) {
    if (closed) return;
    closed = true; text = null; stopWorker();
    for (const promise of pending.values()) promise.reject(error);
    pending.clear();
  }
  function start(blob, retry) {
    let booted = false;
    function failed(error) {
      if (closed) return;
      if (retry && !booted) {stopWorker(); start(!blob,false);}
      else close(error);
    }
    try {
      if (blob) {
        const code = '(' + serveDelimited.toString() + ')(' + createDelimitedIndex.toString() + ')';
        blobURL = URL.createObjectURL(new Blob([code],{type:'text/javascript'}));
        worker = new Worker(blobURL);
      } else worker = new Worker(new URL('./delimited-worker.js',import.meta.url),{type:'module'});
      startupTimer = setTimeout(() => failed(new Error('Table worker did not start')),4000);
      worker.onerror = event => {event.preventDefault(); failed(new Error(event.message || 'Table worker failed'));};
      worker.onmessageerror = () => failed(new Error('Table worker message failed'));
      worker.onmessage = ({data}) => {
        if (data.boot && !booted) {
          booted = true; clearTimeout(startupTimer);
          try {worker.postMessage({id:0,kind:'open',text,separator}); text = null;}
          catch (error) {close(error);}
          return;
        }
        const promise = pending.get(data.id);
        if (!promise) return;
        pending.delete(data.id);
        if (data.error) {
          const error = Object.assign(new Error(data.error.message),data.error);
          promise.reject(error);
          if (data.id === 0) close(error);
        } else promise.resolve(data.result);
      };
    } catch (error) {failed(error);}
  }
  const ready = new Promise((resolve,reject) => pending.set(0,{resolve,reject}));
  start(!!globalThis.go?.main?.App,true);
  async function request(kind, payload) {
    await ready;
    if (closed) throw new DOMException('Closed','AbortError');
    const id = nextId++;
    return new Promise((resolve,reject) => {
      pending.set(id,{resolve,reject});
      try {worker.postMessage({id,kind,...payload});}
      catch (error) {pending.delete(id); reject(error);}
    });
  }
  return {
    ready, read:(...args) => request('read',{args}), cellRange:(...args) => request('cellRange',{args}),
    transform:operation => request('transform',{operation}), commit:() => request('commit',{}), close:() => close()
  };
}
