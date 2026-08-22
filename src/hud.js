// UI 1 (minimal circular HUD) is shown by default. Press 1/2/3 to switch to
// another design preview; there's always exactly one showing.
const huds = {
  1: document.getElementById('hud-1'),
  2: document.getElementById('hud-2'),
  3: document.getElementById('hud-3'),
};

window.addEventListener('keydown', (e) => {
  const target = huds[e.key];
  if (!target) return;

  for (const hud of Object.values(huds)) hud.classList.remove('active');
  target.classList.add('active');
});
