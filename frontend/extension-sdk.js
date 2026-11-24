// Embedded in the extension's own document. Keep this function self-contained.
export function setupExtensionAPI(send) {
  let handlers = null, sequence = 0;
  const pending = new Map();

  addEventListener('message', event => {
    if (event.source !== parent || !handlers) return;
    const message = event.data;
    switch (message?.type) {
      case 'videron:data': handlers.onData?.(message); break;
      case 'videron:command': handlers.onCommand?.(message); break;
      case 'videron:theme': handlers.onTheme?.(message.theme); break;
      case 'videron:response': {
        const request = pending.get(message.requestId);
        if (!request) return;
        pending.delete(message.requestId);
        clearTimeout(request.timeout);
        if (typeof message.error === 'string') request.reject(new Error(message.error));
        else request.resolve(message.result);
        break;
      }
    }
  });

  function request(method, params) {
    if (!handlers) return Promise.reject(new Error('Call videron.start() first.'));
    const requestId = 'sdk-' + ++sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('The extension host did not reply.'));
      }, 15000);
      pending.set(requestId, {resolve, reject, timeout});
      try { send({type:'videron:request', requestId, method, params}); }
      catch (error) {
        pending.delete(requestId);
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  window.videron = Object.freeze({
    start(callbacks = {}) {
      if (handlers) throw new Error('videron.start() was already called.');
      handlers = callbacks;
      send({type:'videron:ready'});
    },
    openNote(id) { send({type:'videron:open-note', id}); },
    notes: Object.freeze({
      read: () => request('notes.read', {}),
      append: text => request('notes.append', {text}),
      create: (title, text = '') => request('notes.create', {title, text}),
    }),
  });
}
