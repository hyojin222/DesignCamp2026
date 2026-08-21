// Press 1 or 2 to preview a UI overlay design on top of the 3D scene; press
// the same key again to hide it. Only one is shown at a time.
const huds = {
  1: document.getElementById('hud-1'),
  2: document.getElementById('hud-2'),
};

function buildHexRing() {
  const ring = document.getElementById('hud1-hex-ring');
  if (!ring) return;
  const cx = 968;
  const cy = 555;
  const radius = 705;
  const hexRadius = 15;
  const count = 26;

  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);

    const points = [];
    for (let p = 0; p < 6; p++) {
      const a = (Math.PI / 3) * p + Math.PI / 6;
      points.push(`${x + hexRadius * Math.cos(a)},${y + hexRadius * Math.sin(a)}`);
    }

    const hex = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    hex.setAttribute('points', points.join(' '));
    ring.appendChild(hex);
  }
}

buildHexRing();

window.addEventListener('keydown', (e) => {
  if (e.key !== '1' && e.key !== '2') return;
  const target = huds[e.key];
  if (!target) return;

  const wasActive = target.classList.contains('active');
  for (const hud of Object.values(huds)) hud.classList.remove('active');
  if (!wasActive) target.classList.add('active');
});
