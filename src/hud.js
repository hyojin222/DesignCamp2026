// UI 1 (minimal circular HUD) is shown by default. Press 1/2/3 to switch to
// another design preview; there's always exactly one showing.
const huds = {
  1: document.getElementById('hud-1'),
  2: document.getElementById('hud-2'),
  3: document.getElementById('hud-3'),
};

function buildHexRing(ringId) {
  const ring = document.getElementById(ringId);
  if (!ring) return;
  const cx = 968;
  const cy = 555;
  const radius = 705;
  const hexRadius = 9;
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

buildHexRing('hud1-hex-ring');
buildHexRing('hud2-hex-ring');

window.addEventListener('keydown', (e) => {
  const target = huds[e.key];
  if (!target) return;

  for (const hud of Object.values(huds)) hud.classList.remove('active');
  target.classList.add('active');
});
