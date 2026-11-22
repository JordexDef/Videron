import {serveLineTransforms, transformRows} from './data-transform-worker.js';

// A separate worker per operation releases its row index on completion and
// allows closing the editor to cancel even an in-progress native Array.sort.
export function transformDataLines(text, operation, {language = 'ru', signal} = {}) {
  return new Promise((resolve, reject) => {
    let worker, blobURL, startupTimer;
    function stop() {
      clearTimeout(startupTimer);
      if (worker) {
        worker.onerror = worker.onmessage = null;
        worker.terminate(); worker = null;
      }
      if (blobURL) { URL.revokeObjectURL(blobURL); blobURL = null; }
    }
    function finish(error, result) {
      stop();
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result);
    }
    function abort() { finish(new DOMException('Cancelled', 'AbortError')); }
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, {once:true});

    function start(useBlob, retry) {
      function failedToStart(error) {
        if (retry) { stop(); start(!useBlob, false); }
        else finish(error);
      }
      try {
        if (useBlob) {
          const source = '(' + serveLineTransforms.toString() + ')(' + transformRows.toString() + ')';
          blobURL = URL.createObjectURL(new Blob([source], {type:'text/javascript'}));
          worker = new Worker(blobURL);
        } else {
          worker = new Worker(new URL('./data-transform-worker.js', import.meta.url), {type:'module'});
        }
        let ready = false;
        startupTimer = setTimeout(() => failedToStart(new Error('Line worker did not start')), 4000);
        worker.onerror = event => {
          event.preventDefault();
          const error = new Error(event.message || 'Could not run line operation');
          if (!ready) failedToStart(error);
          else finish(error);
        };
        worker.onmessage = ({data}) => {
          if (data.ready) {
            clearTimeout(startupTimer);
            ready = true;
            try { worker.postMessage({text, operation, language}); }
            catch (error) { finish(error); }
          } else if (data.error) finish(new Error(data.error));
          else finish(null, data.result);
        };
      } catch (error) {
        failedToStart(error);
      }
    }
    // An embedded desktop origin can leave a module worker waiting for assets.
    // A blob starts from the already loaded source without a second request.
    start(!!globalThis.go?.main?.App, true);
  });
}
