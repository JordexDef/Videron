(() => {
  const map = document.querySelector('.map');
  const compact = matchMedia('(max-width: 600px) and (max-aspect-ratio: 1/1), (max-width: 600px) and (min-height: 491px)');
  const parts = new Map();
  const notesById = new Map();
  let width, height, drag;

  function position(element) {
    const matrix = element.transform.baseVal.getItem(0).matrix;
    return { x: matrix.e, y: matrix.f };
  }

  function control(element, group, note) {
    element.setAttribute('tabindex', '0');
    element.setAttribute('role', 'group');
    element.setAttribute('aria-roledescription', note ? 'перемещаемая заметка' : 'перемещаемая группа');
    parts.set(element, { group, note, element });
  }

  const groups = Array.from(map.querySelectorAll('.folder'), element => {
    const skin = element.querySelector('.folder-skin');
    const wide = position(element);
    const [x, y] = element.dataset.narrow.split(' ').map(Number);
    const group = { element, wide, narrow: { x, y }, ...wide, radius: skin.r.baseVal.value };
    control(skin, group);
    group.notes = Array.from(element.querySelectorAll('.note'), item => {
      const note = { element: item, group, ...position(item), radius: item.querySelector('.disc').r.baseVal.value };
      control(item, group, note);
      notesById.set(item.id, note);
      return note;
    });
    return group;
  });

  function links(selector, attribute) {
    return Array.from(map.querySelectorAll(selector), element => {
      const ends = element.dataset[attribute].split(' ').map(id => notesById.get(id));
      return { element, ends };
    });
  }

  const connections = links('.connections', 'edges');
  const bridges = links('.bridge', 'between');

  function paint() {
    for (const group of groups) {
      group.element.setAttribute('transform', `translate(${group.x} ${group.y})`);
      for (const note of group.notes) {
        note.element.setAttribute('transform', `translate(${note.x} ${note.y})`);
      }
    }
    for (const { element, ends } of connections) {
      let path = '';
      for (let i = 0; i < ends.length; i += 2) {
        const a = ends[i], b = ends[i + 1];
        path += `M${a.x} ${a.y}L${b.x} ${b.y}`;
      }
      element.setAttribute('d', path);
    }
    for (const { element, ends: [a, b] } of bridges) {
      const x1 = a.group.x + a.x, y1 = a.group.y + a.y;
      const x2 = b.group.x + b.x, y2 = b.group.y + b.y;
      const midX = (x1 + x2) / 2 - (y2 - y1) * .07;
      const midY = (y1 + y2) / 2 + (x2 - x1) * .07;
      element.setAttribute('d', `M${x1} ${y1}Q${midX} ${midY} ${x2} ${y2}`);
    }
  }

  function confineGroup(group) {
    const inset = group.radius + 4;
    group.x = Math.min(width - inset, Math.max(inset, group.x));
    group.y = Math.min(height - inset, Math.max(inset, group.y));
  }

  function confineNote(note) {
    const limit = note.group.radius - note.radius - 5;
    const distance = Math.hypot(note.x, note.y);
    if (distance <= limit) return;
    note.x *= limit / distance;
    note.y *= limit / distance;
  }

  // Disc contacts move both neighbors unless one of them is held by the pointer.
  function separate(discs, pinned, gap, confine) {
    for (let pass = 0; pass < 12; pass++) {
      let moved = false;
      for (let i = 0; i < discs.length; i++) {
        for (let j = i + 1; j < discs.length; j++) {
          const a = discs[i], b = discs[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const distance = Math.hypot(dx, dy);
          const overlap = a.radius + b.radius + gap - distance;
          if (overlap <= .05) continue;
          const ux = distance > .001 ? dx / distance : 1;
          const uy = distance > .001 ? dy / distance : 0;
          const share = a === pinned ? 0 : b === pinned ? 1 : .5;
          a.x -= ux * overlap * share;
          a.y -= uy * overlap * share;
          b.x += ux * overlap * (1 - share);
          b.y += uy * overlap * (1 - share);
          confine(a);
          confine(b);
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  function movePart({ group, note }, x, y) {
    if (note) {
      const beforeX = note.x, beforeY = note.y;
      note.x = x - group.x;
      note.y = y - group.y;
      // Once the note reaches its folder rim it carries the folder with it.
      confineNote(note);
      group.x = x - note.x;
      group.y = y - note.y;
      confineGroup(group);
      note.x = x - group.x;
      note.y = y - group.y;
      confineNote(note);
      for (const neighbor of group.notes) {
        if (neighbor === note) continue;
        neighbor.x += (note.x - beforeX) * .13;
        neighbor.y += (note.y - beforeY) * .13;
        confineNote(neighbor);
      }
      separate(group.notes, note, 3, confineNote);
    } else {
      group.x = x;
      group.y = y;
      confineGroup(group);
    }
    separate(groups, group, 5, confineGroup);
    paint();
  }

  function stopDrag() {
    if (!drag) return;
    const { part, pointerId } = drag;
    drag = null;
    part.element.classList.remove('held');
    map.classList.remove('dragging');
    if (map.hasPointerCapture(pointerId)) map.releasePointerCapture(pointerId);
  }

  function layout() {
    stopDrag();
    const nextWidth = compact.matches ? 440 : 880;
    const nextHeight = compact.matches ? 428 : 390;
    const layoutKey = compact.matches ? 'narrow' : 'wide';
    for (const group of groups) {
      const anchor = group[layoutKey];
      if (width) {
        const previous = group[compact.matches ? 'wide' : 'narrow'];
        group.x = anchor.x + (group.x - previous.x) * nextWidth / width;
        group.y = anchor.y + (group.y - previous.y) * nextHeight / height;
      } else {
        group.x = anchor.x;
        group.y = anchor.y;
      }
    }
    width = nextWidth;
    height = nextHeight;
    map.setAttribute('viewBox', `0 0 ${width} ${height}`);
    groups.forEach(confineGroup);
    separate(groups, null, 5, confineGroup);
    paint();
  }

  function point(event) {
    return new DOMPoint(event.clientX, event.clientY).matrixTransform(map.getScreenCTM().inverse());
  }

  function center({ group, note }) {
    return { x: group.x + (note?.x || 0), y: group.y + (note?.y || 0) };
  }

  map.addEventListener('pointerdown', event => {
    const part = parts.get(event.target.closest('.note, .folder-skin'));
    if (!part || drag || event.button !== 0) return;
    const p = point(event), c = center(part);
    drag = { part, pointerId: event.pointerId, offsetX: p.x - c.x, offsetY: p.y - c.y };
    map.setPointerCapture(event.pointerId);
    part.element.classList.add('held');
    map.classList.add('dragging', 'explored');
    event.preventDefault();
  });

  map.addEventListener('pointermove', event => {
    if (drag?.pointerId !== event.pointerId) return;
    const p = point(event);
    movePart(drag.part, p.x - drag.offsetX, p.y - drag.offsetY);
  });

  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    map.addEventListener(type, event => {
      if (drag?.pointerId === event.pointerId) stopDrag();
    });
  }

  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  map.addEventListener('keydown', event => {
    const part = parts.get(event.target), delta = arrows[event.key];
    if (!part || !delta || drag) return;
    event.preventDefault();
    map.classList.add('explored');
    const c = center(part), step = event.shiftKey ? 24 : 8;
    movePart(part, c.x + delta[0] * step, c.y + delta[1] * step);
  });

  layout();
  compact.addEventListener('change', layout);
  map.classList.add('interactive');
})();
