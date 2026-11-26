export const titleSpoilerWidth = 62;
const height = 10;

// A fixed seed keeps the texture stable across redraws. Nothing about the note
// or its title contributes to the layout or motion of these particles.
let seed = 724397;
function sample() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return (seed >>> 8) / 16777216;
}
const between = (min, max) => Math.round((min + sample() * (max - min)) * 100) / 100;

export const titleParticles = Array.from({length: 42}, () => ({
  x: between(0.5, titleSpoilerWidth - 0.5),
  y: between(0.5, height - 0.5),
  radius: between(0.38, 0.84),
  opacity: between(0.26, 0.8),
  dx: between(-7, 7),
  dy: between(-3.5, 3.5),
  duration: between(0.9, 2.8),
  phase: between(0, 3),
}));

export function configureTitleSpoilers(doc) {
  const dots = titleParticles.map(dot =>
    `<circle cx="${dot.x}" cy="${dot.y}" r="${dot.radius}" opacity="${dot.opacity}"/>`).join('');
  const mask = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${titleSpoilerWidth} ${height}">${dots}</svg>`;
  doc.documentElement.style.setProperty('--note-title-speckles', `url("data:image/svg+xml,${encodeURIComponent(mask)}")`);
}

let template;
export function animateTitleSpoiler(spoiler) {
  const doc = spoiler.ownerDocument;
  if (!template || template.ownerDocument !== doc) {
    template = doc.createElement('template');
    for (const dot of titleParticles) {
      const node = doc.createElement('i');
      node.style.cssText = `left:${dot.x}px;top:${dot.y}px;width:${2 * dot.radius}px;height:${2 * dot.radius}px;` +
        `--dx:${dot.dx}px;--dy:${dot.dy}px;--alpha:${dot.opacity};--duration:${dot.duration}s;--phase:${dot.phase}s`;
      template.content.append(node);
    }
  }
  spoiler.style.setProperty('--start-phase', `${Math.random() * 3}s`);
  spoiler.classList.add('has-title-particles');
  spoiler.append(template.content.cloneNode(true));
}
