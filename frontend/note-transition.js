let activeTransition = null;

export function cancelNoteTransition() {
  activeTransition?.();
}

export function returnToNoteMap(graph, id, visit, space) {
  if (!visit) { graph.focus(id); return; }
  if (visit.space !== space || !visit.camera) return;
  graph.restoreCamera(visit.camera);
  if (visit.origin !== 'map' || document.hidden) return;

  let destination = graph.noteViewportRect(id);
  // A linked note, a resized window or a synced move can put a bubble outside the old view.
  if (!destination) {
    const node = graph.nodes.get(id);
    if (!node) return;
    graph.restoreCamera({x:node.x, y:node.y, zoom:visit.camera.zoom});
    destination = graph.noteViewportRect(id);
  }
  if (destination) {
    graph.showReturnCue(id);
    playNoteTransition('close', destination);
  }
}

// The editor and closing sheet fill the space beneath the tabs. Moving only
// their clip keeps text at reading size and leaves layout and focus alone.
export function playNoteTransition(direction, rect, editorElement) {
  cancelNoteTransition();
  if (!rect || document.hidden) return;
  const closing = direction === 'close';
  if (!closing && !editorElement?.isConnected) return;
  const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  if (!motion || motion.matches) return;

  const {left, top, width, height} = rect;
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;
  const full = {clipPath: 'inset(0px 0px 0px 0px round 0px)'};

  // Close after unmount. The temporary surface never holds note contents.
  const surface = closing ? document.createElement('div') : editorElement;
  if (!surface.animate || !window.CSS?.supports('clip-path', full.clipPath)) return;
  if (closing) {
    surface.className = 'note-transition-sheet';
    surface.setAttribute('aria-hidden', 'true');
    document.body.append(surface);
  }
  const bounds = surface.getBoundingClientRect();
  const clipLeft = Math.max(bounds.left, left), clipTop = Math.max(bounds.top, top);
  const clipRight = Math.min(bounds.right, left + width), clipBottom = Math.min(bounds.bottom, top + height);
  if (clipRight <= clipLeft || clipBottom <= clipTop) {
    if (closing) surface.remove();
    return;
  }
  const radius = Math.min(clipRight - clipLeft, clipBottom - clipTop) / 2;
  const circle = {clipPath: `inset(${clipTop - bounds.top}px ${bounds.right - clipRight}px ${bounds.bottom - clipBottom}px ${clipLeft - bounds.left}px round ${radius}px)`};
  let animation;
  try {
    animation = surface.animate(closing ? [full, circle] : [circle, full], {
      duration: closing ? 145 : 180,
      easing: closing ? 'cubic-bezier(.42,0,.38,1)' : 'cubic-bezier(.2,.65,.25,1)',
      fill: 'both'
    });
  } catch {
    if (closing) surface.remove();
    return;
  }
  const events = new AbortController();
  function finish() {
    if (activeTransition !== finish) return;
    activeTransition = null;
    events.abort();
    animation.onfinish = animation.oncancel = null;
    animation.cancel();
    if (closing) surface.remove();
  }
  activeTransition = finish;
  animation.onfinish = animation.oncancel = finish;
  const options = {signal: events.signal};
  document.addEventListener('visibilitychange', finish, options);
  window.addEventListener('pagehide', finish, options);
  window.addEventListener('resize', finish, options);
  motion.addEventListener('change', finish, options);
  if (closing) {
    // A new map gesture takes precedence over the last frames of the return.
    const gesture = {...options, capture: true, passive: true};
    window.addEventListener('pointerdown', finish, gesture);
    window.addEventListener('wheel', finish, gesture);
  }
}
