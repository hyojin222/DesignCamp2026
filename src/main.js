import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';

// ============================================================================
// Look & feel tuning — kept together here since these get tweaked a lot.
// ============================================================================
const YELLOW_COLOR = 0xffe600; // the flat "노란 단색" every object is permanently shown in
// Scene background color, visible through the goggle-shaped cutout in the
// HUD porthole. The frame area outside the cutout is white — that's the
// static fill on the #hud1-frame rect in index.html, untouched from here.
const BG_YELLOW_COLOR = 0xfff075;
const RENDER_EXPOSURE = 2.5; // renderer.toneMappingExposure — lower = darker overall, less washed-out/ivory highlights
// The yellow material's roughness: lower = tighter, brighter specular
// highlight from the key/fill lights (more visible "shine"); higher =
// softer/duller, closer to no highlight at all (1.0 is roughly the old look).
const YELLOW_LIT_ROUGHNESS = 0.35;
// The yellow material's shaded/dark side would otherwise just fade toward a
// dull, desaturated gray-yellow as light falls off. This emissive accent
// (usually a deeper, more saturated version of YELLOW_COLOR) adds a
// light-independent floor of color, so the shadow side stays rich/colorful
// instead of muddy.
const YELLOW_SHADOW_COLOR = 0xE8A000;
const YELLOW_SHADOW_INTENSITY = 0.25; // 0 = no boost, higher = richer/brighter shadow
// Ambient light lands equally on every face regardless of orientation, so
// raising it lifts the shadow/unlit side of objects toward a flatter, more
// matte look without touching the side already lit by the key/fill lights.
const AMBIENT_LIGHT_INTENSITY = 0.6;

// Wall-gallery tuning: every loaded model is placed once on an invisible
// wall (same z, spread across x/y) in its permanent close-up + yellow look.
// The back/forward buttons jump the camera to a different random object on
// that wall, staying at close-up zoom throughout instead of zooming out.
// Target close-up distance, x the object's bounding radius (half the
// bounding box's diagonal) — this is the "how close/zoomed" dial. It's only
// a target, not a hard floor: computeCloseView() below clamps the actual
// distance to never come in closer than the object's *real* surface (see
// INITIAL_SURFACE_SAFETY_MULTIPLIER), so tightening this can't place the
// camera's starting position inside the mesh even when it's well under 1.
const MIN_SAFE_ZOOM_MULTIPLIER = 0.55;
// How far the user can zoom in/out from the focused object's close-up
// distance, as a +/-fraction of it.
const ZOOM_RANGE_FRACTION = 0.1;
const PAN_TRANSITION_DURATION = 0.9; // seconds, eased camera pan between objects
const AUTO_ADVANCE_INTERVAL = 5; // seconds between automatic forward advances (paused while dragging or in debug mode)
// Free-camera rotate speed used only in debug mode (TrackballControls'
// rotateSpeed) — the normal drag-to-rotate-the-object interaction below has
// its own OBJECT_ROTATE_SPEED, since it isn't driven by TrackballControls.
const DEBUG_DRAG_ROTATE_SPEED = 2.5;
// Radians the focused object turns per pixel of pointer drag. This is what
// makes dragging spin the object itself (camera fixed) instead of orbiting
// the camera around it.
const OBJECT_ROTATE_SPEED = 0.008;
// How quickly the object's drag-rotation coasts to a stop after release —
// closer to 1 glides longer, closer to 0 stops almost immediately.
const OBJECT_ROTATE_INERTIA_DAMPING = 0.92;
const OBJECT_ROTATE_INERTIA_STOP = 0.0005; // rad/frame below which coasting just snaps to 0
// How much the camera dollies per wheel-scroll unit, as a fraction of its
// current distance from the focused object (exponential, so it feels the
// same whether zoomed in tight or backed off toward the zoom limit).
const WHEEL_ZOOM_SPEED = 0.0015;
// ============================================================================

const app = document.getElementById('app');
const statusEl = document.getElementById('status');
const wordListEl = document.getElementById('word-list');
const btnRandomObject = document.getElementById('btn-random-object');
const cameraXEl = document.getElementById('camera-x');
const cameraYEl = document.getElementById('camera-y');
const hud1Svg = document.getElementById('hud1-svg');
const hud1MaskBg = document.getElementById('hud1-mask-bg');
const hud1Frame = document.getElementById('hud1-frame');

const scene = new THREE.Scene();
scene.background = new THREE.Color(BG_YELLOW_COLOR);

const camera = new THREE.PerspectiveCamera(
  45,
  app.clientWidth / app.clientHeight,
  0.01,
  1000
);
camera.position.set(0, 0, 3);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(app.clientWidth, app.clientHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Without this, bright spots where lights overlap just clip to white instead
// of rolling off — e.g. the yellow filter (#ffdd00) reads lighter/whiter
// than its actual hex value wherever the lighting pushes past 1.0.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = RENDER_EXPOSURE;
app.appendChild(renderer.domElement);

// TrackballControls is only ever active in debug mode now (free-roam camera
// for development) — the normal gallery interaction drags the focused
// *object* instead of orbiting the camera around it (see the pointer
// handlers below), so it's driven by hand rather than by this instance.
// Kept as TrackballControls rather than OrbitControls for debug mode since
// OrbitControls clamps its polar angle to [0, pi] (can't rotate past looking
// straight up/down); TrackballControls has no such polar singularity.
const controls = new TrackballControls(camera, renderer.domElement);
controls.enabled = false;
controls.noPan = true;
controls.staticMoving = false;
controls.dynamicDampingFactor = 0.08; // roughly analogous to OrbitControls' dampingFactor
controls.rotateSpeed = DEBUG_DRAG_ROTATE_SPEED;
// Real min/max are set in applyZoomLimits(), scaled to the focused object's close distance.
controls.minDistance = 0.05;
controls.maxDistance = 50;

scene.add(new THREE.AmbientLight(0xffffff, AMBIENT_LIGHT_INTENSITY));
const keyLight = new THREE.DirectionalLight(0xffffff, 2);
keyLight.position.set(3, 5, 4);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xffffff, 0.8);
fillLight.position.set(-4, -2, -3);
scene.add(fillLight);

const gltfLoader = new GLTFLoader();
const objLoader = new OBJLoader();
const textureLoader = new THREE.TextureLoader();
const BASE = import.meta.env.BASE_URL;

// Looping background music (copied verbatim to public/sound/ by
// scripts/generate-assets.mjs). Browsers block audio autoplay until the user
// has interacted with the page at least once, so a blocked first attempt
// just waits for that — no visible retry/prompt needed, it starts silently
// the moment the user does anything (click, drag, key press).
const BGM_VOLUME = 0.5;
const bgm = new Audio(`${BASE}sound/samuelfjohanns-spaceshiptexture.mp3`);
bgm.loop = true;
bgm.volume = BGM_VOLUME;
bgm.play().catch(() => {
  const resume = () => bgm.play().catch(() => {});
  window.addEventListener('pointerdown', resume, { once: true });
  window.addEventListener('keydown', resume, { once: true });
});

// Fixed height of the HUD's coordinate space; the width instead tracks the
// window's actual aspect ratio (see syncHudViewBox()) so the viewBox's own
// aspect ratio always matches the window's — otherwise preserveAspectRatio's
// "slice" has overflow to crop on whichever axis the two ratios disagree on,
// which is what was cutting the now-edge-to-edge goggle shape's left/right
// sides on any window that wasn't exactly 16:9.
const HUD_HEIGHT = 1080;
let hudViewBoxWidth = HUD_HEIGHT * (app.clientWidth / app.clientHeight);
// The fetched goggle SVG's own height/width ratio, so its box can be
// recomputed on resize without re-fetching. Starts out matching the static
// fallback shape's ratio (998.11/1837.74) until the real one loads.
let goggleAspectRatio = 998.11 / 1837.74;
const GOGGLE_MASK_TOP_MARGIN = 40; // gap above the goggle, in HUD units (HUD_HEIGHT tall)
// Left/right margin as a fraction of the (dynamic) HUD width, so it scales
// with the window instead of being a fixed number of units.
const GOGGLE_MASK_SIDE_MARGIN_FRACTION = 0.05;

// Sizes the goggle shape to fit within its margins — called both right after
// it loads and on every resize.
function applyGoggleMaskBox() {
  const shape = document.getElementById('hud1-goggle-shape');
  if (!shape) return;
  const sideMargin = hudViewBoxWidth * GOGGLE_MASK_SIDE_MARGIN_FRACTION;
  const width = hudViewBoxWidth - sideMargin * 2;
  shape.setAttribute('x', sideMargin);
  shape.setAttribute('y', GOGGLE_MASK_TOP_MARGIN);
  shape.setAttribute('width', width);
  shape.setAttribute('height', width * goggleAspectRatio);
}

// Keeps the HUD's viewBox width (and everything sized off it) matched to the
// window's actual aspect ratio — see the HUD_HEIGHT comment above.
function syncHudViewBox() {
  hudViewBoxWidth = HUD_HEIGHT * (app.clientWidth / app.clientHeight);
  hud1Svg.setAttribute('viewBox', `0 0 ${hudViewBoxWidth} ${HUD_HEIGHT}`);
  hud1MaskBg.setAttribute('width', hudViewBoxWidth);
  hud1Frame.setAttribute('width', hudViewBoxWidth);
  applyGoggleMaskBox();
}
syncHudViewBox();

const SVG_NS = 'http://www.w3.org/2000/svg';

// Fetches source/layout/goggle.svg (copied verbatim to public/layout/ by
// scripts/generate-assets.mjs) and swaps it in for the static fallback shape
// in index.html's porthole mask, so editing that source file and reloading
// is all it takes to change the goggle cutout — no hardcoded path to update.
async function loadGoggleMask() {
  try {
    const res = await fetch(`${BASE}layout/goggle.svg`);
    if (!res.ok) return;
    const doc = new DOMParser().parseFromString(await res.text(), 'image/svg+xml');
    if (doc.querySelector('parsererror')) return;
    const source = doc.documentElement;
    const paths = Array.from(source.querySelectorAll('path'));
    if (!paths.length) return;

    const viewBoxParts = (source.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
    const [, , vbWidth, vbHeight] = viewBoxParts.length === 4 ? viewBoxParts : [0, 0, 1, 1];
    if (vbWidth > 0) goggleAspectRatio = vbHeight / vbWidth;

    const nested = document.createElementNS(SVG_NS, 'svg');
    nested.setAttribute('id', 'hud1-goggle-shape');
    nested.setAttribute('viewBox', source.getAttribute('viewBox') || `0 0 1 ${goggleAspectRatio}`);
    nested.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    // The mask hole is whatever's filled black here, regardless of the
    // source SVG's own fill/class styling — only its path shapes matter.
    for (const p of paths) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', p.getAttribute('d'));
      path.setAttribute('fill', 'black');
      nested.appendChild(path);
    }

    document.getElementById('hud1-goggle-shape')?.replaceWith(nested);
    applyGoggleMaskBox();
  } catch (err) {
    console.error('goggle mask load failed, keeping fallback shape', err);
  }
}
loadGoggleMask();

// Fetches an icon SVG (copied verbatim to public/icon/ by
// scripts/generate-assets.mjs) and swaps it in for whatever fallback markup
// is currently inside `button`, so editing the source icon and reloading is
// all it takes — no hardcoded path to update. Color comes entirely from this
// button's own CSS (`fill: currentColor`-style inheritance): the source
// SVG's own fill is dropped, same reasoning as the goggle mask above.
async function loadButtonIcon(button, url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    const doc = new DOMParser().parseFromString(await res.text(), 'image/svg+xml');
    if (doc.querySelector('parsererror')) return;
    const source = doc.documentElement;
    const viewBox = source.getAttribute('viewBox');
    const paths = Array.from(source.querySelectorAll('path'));
    if (!viewBox || !paths.length) return;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', viewBox);
    for (const p of paths) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', p.getAttribute('d'));
      svg.appendChild(path);
    }
    button.replaceChildren(svg);
  } catch (err) {
    console.error(`icon load failed for ${url}, keeping fallback icon`, err);
  }
}
loadButtonIcon(btnRandomObject, `${BASE}icon/re.svg`);

const clock = new THREE.Clock();
let elapsedTime = 0;
// Throttles the camera x/y readout's own update rate well below the render
// loop's ~60fps — it shows the *live*, wiggle-included position, and at full
// frame rate the sway makes the digits change too fast to actually read.
const COORD_UPDATE_INTERVAL = 1 / 12;
let lastCoordUpdateTime = -Infinity;
// The fall is a touch faster (higher stiffness) than the rise, and damping
// differs so the rise stays smooth while the fall has a visible bounce.
const SPRING_STIFFNESS_RISE = 6;
const SPRING_STIFFNESS_FALL = 8;
const SPRING_DAMPING_RISE = 4.4;
const SPRING_DAMPING_FALL = 2.0;
let dipAmount = 0;
let bobOffset = 0;
let bobVelocity = 0;
let bobTarget = 0;
let currentStiffness = SPRING_STIFFNESS_RISE;
let currentDamping = SPRING_DAMPING_RISE;

// Continuous, slow ambient camera wiggle for the whole session: a gentle
// figure-8-ish drift in screen-space X/Y (never Z, so it never reads as a
// zoom) plus a barely-there rotational sway. Built from two slow sines per
// axis, out of phase, so it never looks like a simple back-and-forth pulse.
const WIGGLE_POS_FACTOR = 0.11; // fraction of the current focus distance
const WIGGLE_ROT_AMP = 0.022; // radians
const WIGGLE_SPEED = 1.7; // slightly faster than the base sine frequencies below
let currentZoomDistance = 1;

function buildMaterial(textures) {
  const material = new THREE.MeshStandardMaterial({ color: 0xd8cdbe, roughness: 0.7, metalness: 0 });
  if (!textures) return material;
  if (textures.map) {
    const map = textureLoader.load(BASE + textures.map);
    map.colorSpace = THREE.SRGBColorSpace;
    material.map = map;
    material.color.set(0xffffff);
  }
  if (textures.normalMap) material.normalMap = textureLoader.load(BASE + textures.normalMap);
  if (textures.roughnessMap) {
    material.roughnessMap = textureLoader.load(BASE + textures.roughnessMap);
    material.roughness = 1;
  }
  if (textures.metalnessMap) {
    material.metalnessMap = textureLoader.load(BASE + textures.metalnessMap);
    material.metalness = 1;
  }
  if (textures.bumpMap) material.bumpMap = textureLoader.load(BASE + textures.bumpMap);
  return material;
}

function randomRange(min, max) {
  return min + Math.random() * (max - min);
}

function randomAxis() {
  const axis = new THREE.Vector3(randomRange(-1, 1), randomRange(-1, 1), randomRange(-1, 1));
  return axis.lengthSq() < 1e-6 ? axis.set(0, 1, 0) : axis.normalize();
}

const TARGET_SIZE = 2.2;
// x/y spacing between neighboring objects on the wall, x TARGET_SIZE — wide
// enough that a neighbor never bleeds into the close-up frame or the pan
// tween between two objects.
const WALL_SPACING = TARGET_SIZE * 3.2;

// Normalize the object to the target size and center its pivot, then wrap it
// in a group at its assigned wall position with a random orientation and its
// own slow spin. The wrapping is what makes rotation not shift the object's
// visual center: the mesh is centered on the group's own origin, so spinning
// the group in place never moves that origin.
function prepareObject(object, wallPos) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  const scale = TARGET_SIZE / maxDim;
  object.scale.setScalar(scale);
  object.position.copy(center).multiplyScalar(-scale);

  const group = new THREE.Group();
  group.add(object);
  group.position.copy(wallPos);
  group.rotation.set(randomRange(0, Math.PI * 2), randomRange(0, Math.PI * 2), randomRange(0, Math.PI * 2));

  // Keeps spinning slowly around its own random axis for as long as the app runs.
  group.userData.spinAxis = randomAxis();
  group.userData.spinSpeed = randomRange(0.015, 0.05);

  applyYellowMaterial(group);
  return group;
}

// A genuine flat-color THREE texture (not just a material.color tweak) —
// a tiny canvas filled solid, used as the base of the permanent yellow look.
function createSolidColorTexture(hexColor) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `#${new THREE.Color(hexColor).getHexString()}`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Every object's permanent look: a lit PBR material carrying over the
// original material's normal/bump maps, so the scene's lights pick up the
// object's real surface detail (wrinkles, dents, etc.) on top of the flat
// yellow color, plus the specular highlight from YELLOW_LIT_ROUGHNESS.
function buildYellowMaterialLit(normal) {
  return new THREE.MeshStandardMaterial({
    map: createSolidColorTexture(YELLOW_COLOR),
    color: 0xffffff,
    roughness: YELLOW_LIT_ROUGHNESS,
    metalness: 0,
    normalMap: normal.normalMap || null,
    normalScale: normal.normalMap ? normal.normalScale.clone() : undefined,
    bumpMap: normal.bumpMap || null,
    bumpScale: normal.bumpMap ? normal.bumpScale : undefined,
    emissive: new THREE.Color(YELLOW_SHADOW_COLOR),
    emissiveIntensity: YELLOW_SHADOW_INTENSITY,
  });
}

function applyYellowMaterial(group) {
  group.traverse((child) => {
    if (!child.isMesh) return;
    child.material = buildYellowMaterialLit(child.material);
  });
}

const _surfaceRayOrigin = new THREE.Vector3();
const _surfaceRayDir = new THREE.Vector3();
const _surfaceRaycaster = new THREE.Raycaster();

// How far the object's *real* surface is from `center` along `dir`, found by
// raycasting against the actual geometry from well outside it. Falls back to
// boundingRadius if the ray somehow doesn't hit anything.
function surfaceDistanceAlong(object, center, dir, boundingRadius) {
  const farOut = boundingRadius * 3 + 1;
  _surfaceRayOrigin.copy(center).addScaledVector(dir, farOut);
  _surfaceRayDir.copy(dir).negate();
  _surfaceRaycaster.set(_surfaceRayOrigin, _surfaceRayDir);
  _surfaceRaycaster.far = farOut * 2;
  const hits = _surfaceRaycaster.intersectObject(object, true);
  if (!hits.length) return boundingRadius;
  return farOut - hits[0].distance;
}

// Hard floor on the initial close-up distance, x the *real* raycast-hit
// surface distance (not the looser bounding radius) — kept separate from
// MIN_SAFE_ZOOM_MULTIPLIER so however tight that's tuned for "how close/
// zoomed" the look should be, the camera's starting position can never land
// inside the actual mesh. Only covers the object's orientation at the moment
// it's framed, though — it keeps spinning afterward, so a low
// MIN_SAFE_ZOOM_MULTIPLIER can still let a different part of it swing closer
// than the camera later.
const INITIAL_SURFACE_SAFETY_MULTIPLIER = 1.05;

// Everything needed to frame one wall object close-up: its world-space
// center, a fixed straight-on viewing direction (every object on the wall is
// framed from the same angle, since the camera only ever pans across the
// wall's face), and the distance along that direction to sit at.
function computeCloseView(object) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const boundingRadius = size.length() / 2;
  const dir = new THREE.Vector3(0, 0, 1);
  const realSurfaceDistance = surfaceDistanceAlong(object, center, dir, boundingRadius);
  const closeDistance = Math.max(
    boundingRadius * MIN_SAFE_ZOOM_MULTIPLIER,
    realSurfaceDistance * INITIAL_SURFACE_SAFETY_MULTIPLIER
  );

  return { center, dir, closeDistance };
}

// --- Wall gallery state -----------------------------------------------------
let wallObjects = []; // [{ group, center, dir, closeDistance }], one per loaded model
let currentObjectIndex = -1;
// Up to LAST_SEEN_LIMIT most-recently-focused object indices (most recent
// last) — excluded when picking the next random object, so back/forward
// never immediately repeat something you just saw.
let lastSeen = [];
const LAST_SEEN_LIMIT = 3;
let panTween = null; // { fromPos, toPos, fromTarget, toTarget, start } — eased camera pan between two objects
// Seconds since the current object was focused (manually or automatically) —
// once it reaches AUTO_ADVANCE_INTERVAL, the gallery auto-advances as if
// forward had been clicked. Frozen while dragging or in debug mode.
let autoAdvanceTimer = 0;
let dragging = false;

// Debug mode (toggled with the '0' key): free camera, no zoom limits.
// Default mode (the wall gallery) is what the app starts in.
let debugMode = false;

// How far the user can zoom in/out from the focused object's close-up
// distance — see ZOOM_RANGE_FRACTION above.
function applyZoomLimits() {
  if (debugMode || currentObjectIndex < 0) return;
  const target = wallObjects[currentObjectIndex].closeDistance;
  controls.minDistance = target * (1 - ZOOM_RANGE_FRACTION);
  controls.maxDistance = target * (1 + ZOOM_RANGE_FRACTION);
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function startPanTween(toPos, toTarget) {
  camera.up.set(0, 1, 0);
  panTween = {
    fromPos: camera.position.clone(),
    toPos: toPos.clone(),
    fromTarget: controls.target.clone(),
    toTarget: toTarget.clone(),
    start: elapsedTime,
  };
}

// Advances the active camera pan; called instead of controls.update() while
// one is in progress so TrackballControls doesn't fight the manual tween.
// Both the camera position and orbit target are lerped directly in 3D — the
// camera stays at close-up zoom throughout the move across the wall instead
// of zooming out and back in.
function updatePanTween() {
  const t = Math.min(1, (elapsedTime - panTween.start) / PAN_TRANSITION_DURATION);
  const e = easeInOutCubic(t);
  camera.position.lerpVectors(panTween.fromPos, panTween.toPos, e);
  controls.target.lerpVectors(panTween.fromTarget, panTween.toTarget, e);
  camera.lookAt(controls.target);
  currentZoomDistance = camera.position.distanceTo(controls.target);
  if (t >= 1) panTween = null;
}

function rememberSeen(index) {
  lastSeen.push(index);
  if (lastSeen.length > LAST_SEEN_LIMIT) lastSeen.shift();
}

// Picks a random wall object, excluding whichever ones are in lastSeen.
function pickNextObjectIndex() {
  const candidates = wallObjects.map((_, i) => i).filter((i) => !lastSeen.includes(i));
  const pool = candidates.length ? candidates : wallObjects.map((_, i) => i).filter((i) => i !== currentObjectIndex);
  return pool[Math.floor(Math.random() * pool.length)];
}

// Bottom-left word list: a fixed 5x2 grid of these 10 foods (a curated
// subset of the wall — some wall objects, like croissant, just have no entry
// here and never get highlighted), each with the same word translated into
// four languages. Every focusObject() call below re-picks one language for
// the *whole* list (never mixed per word) and re-types every word from
// scratch, so the list always reflects the currently-focused wall object.
// Covers every wall object (see buildWall()), not just a curated subset —
// otherwise whichever objects were missing an entry would never get the
// "active" highlight no matter which language happened to be showing,
// which read as a per-language bug even though it was really per-object.
const WORD_LIST_ITEMS = [
  { id: 'anise', words: { ru: 'анис', th: 'ยี่หร่า', ja: 'アニス', zh: '茴香', ar: 'يانسون', he: 'אניס', el: 'γλυκάνισο', ka: 'ანისი', si: 'සොම්පු', fr: 'anis' } },
  { id: 'avocado', words: { ru: 'авокадо', th: 'อะโวคาโด', ja: 'アボカド', zh: '牛油果', ar: 'أفوكادو', he: 'אבוקדו', el: 'αβοκάντο', ka: 'ავოკადო', si: 'අලිගැටපේර', fr: 'avocat' } },
  { id: 'bread', words: { ru: 'хлеб', th: 'ขนมปัง', ja: 'パン', zh: '面包', ar: 'خبز', he: 'לחם', el: 'ψωμί', ka: 'პური', si: 'පාන්', fr: 'pain' } },
  { id: 'cookie', words: { ru: 'печенье', th: 'คุกกี้', ja: 'クッキー', zh: '曲奇', ar: 'بسكويت', he: 'עוגייה', el: 'μπισκότο', ka: 'ბისკვიტი', si: 'බිස්කට්', fr: 'biscuit' } },
  { id: 'corn', words: { ru: 'кукуруза', th: 'ข้าวโพด', ja: 'とうもろこし', zh: '玉米', ar: 'ذرة', he: 'תירס', el: 'καλαμπόκι', ka: 'სიმინდი', si: 'බඩඉරිඟු', fr: 'maïs' } },
  { id: 'grapefruit', words: { ru: 'грейпфрут', th: 'เกรปฟรุต', ja: 'グレープフルーツ', zh: '葡萄柚', ar: 'جريب فروت', he: 'אשכולית', el: 'γκρέιπφρουτ', ka: 'გრეიფრუტი', si: 'ග්‍රේප් ෆෘට්', fr: 'pamplemousse' } },
  { id: 'strawberry', words: { ru: 'клубника', th: 'สตรอว์เบอร์รี', ja: 'いちご', zh: '草莓', ar: 'فراولة', he: 'תות שדה', el: 'φράουλα', ka: 'მარწყვი', si: 'ස්ට්‍රෝබෙරි', fr: 'fraise' } },
  { id: 'sushi', words: { ru: 'суши', th: 'ซูชิ', ja: '寿司', zh: '寿司', ar: 'سوشي', he: 'סושי', el: 'σούσι', ka: 'სუში', si: 'සුෂි', fr: 'sushi' } },
  { id: 'tartlet', words: { ru: 'тарталетки', th: 'ทาร์ต', ja: 'タルト', zh: '挞', ar: 'تارت', he: 'טרטלט', el: 'ταρτάκι', ka: 'ტარტი', si: 'ටාට්', fr: 'tartelette' } },
  { id: 'chicken-leg-smoked', words: { ru: 'курица', th: 'ไก่', ja: '鶏肉', zh: '鸡肉', ar: 'دجاج', he: 'עוף', el: 'κοτόπουλο', ka: 'ქათამი', si: 'කුකුල් මස්', fr: 'poulet' } },
  { id: 'croissant', words: { ru: 'круассан', th: 'ครัวซองต์', ja: 'クロワッサン', zh: '牛角包', ar: 'كرواسون', he: 'קרואסון', el: 'κρουασάν', ka: 'კრუასანი', si: 'ක්‍රුවසෝන්', fr: 'croissant' } },
  { id: 'donut', words: { ru: 'пончик', th: 'โดนัท', ja: 'ドーナツ', zh: '甜甜圈', ar: 'دونات', he: 'דונאט', el: 'ντόνατ', ka: 'დონატი', si: 'ඩෝනට්', fr: 'beignet' } },
  { id: 'flyagaric', words: { ru: 'гриб', th: 'เห็ด', ja: 'きのこ', zh: '蘑菇', ar: 'فطر', he: 'פטריה', el: 'μανιτάρι', ka: 'სოკო', si: 'හතු', fr: 'champignon' } },
];
const WORD_LIST_LANGUAGES = ['ru', 'th', 'ja', 'zh', 'ar', 'he', 'el', 'ka', 'si', 'fr'];
const WORD_TYPE_INTERVAL = 45; // ms per character revealed
// Starts at a random language, then advances one at a time (wrapping) on
// every renderWordList() call instead of re-rolling fully at random — a
// fresh random pick each time repeated languages far more often than felt
// right with this many options. -1 so the very first render's +1 lands on
// this random starting point instead of skipping past it.
let wordListLanguageIndex = Math.floor(Math.random() * WORD_LIST_LANGUAGES.length) - 1;

const wordListEntries = WORD_LIST_ITEMS.map((item) => {
  const el = document.createElement('span');
  el.className = 'word-item';
  wordListEl.appendChild(el);
  return { id: item.id, words: item.words, el, typeTimer: null };
});

function typewriteWord(entry, text) {
  if (entry.typeTimer) clearInterval(entry.typeTimer);
  entry.el.textContent = '';
  let i = 0;
  entry.typeTimer = setInterval(() => {
    i++;
    entry.el.textContent = text.slice(0, i);
    if (i >= text.length) clearInterval(entry.typeTimer);
  }, WORD_TYPE_INTERVAL);
}

// A trailing digit marks separate models of the same food (e.g. "cookie2"
// alongside "cookie") — strip it so they share one word-list entry instead
// of each needing their own.
function wordListMatchId(id) {
  return id.replace(/\d+$/, '');
}

// Advances the list to its next language and retypes every word,
// highlighting whichever entry matches the currently-focused wall object.
function renderWordList() {
  if (currentObjectIndex < 0) return;
  wordListLanguageIndex = (wordListLanguageIndex + 1) % WORD_LIST_LANGUAGES.length;
  const language = WORD_LIST_LANGUAGES[wordListLanguageIndex];
  const activeId = wordListMatchId(wallObjects[currentObjectIndex].id);
  for (const entry of wordListEntries) {
    entry.el.classList.toggle('active', entry.id === activeId);
    typewriteWord(entry, entry.words[language]);
  }
}

// Points the camera at wallObjects[index]'s close-up framing. Cuts instantly
// for the very first object; every later call eases the camera across the
// wall from wherever it currently is, staying at close-up zoom the whole way.
function focusObject(index, { instant = false } = {}) {
  currentObjectIndex = index;
  rememberSeen(index);
  autoAdvanceTimer = 0;
  const view = wallObjects[index];

  const toPos = view.center.clone().addScaledVector(view.dir, view.closeDistance);
  const toTarget = view.center;

  panTween = null;
  if (instant) {
    camera.up.set(0, 1, 0);
    camera.position.copy(toPos);
    controls.target.copy(toTarget);
    camera.lookAt(controls.target);
    currentZoomDistance = view.closeDistance;
  } else {
    startPanTween(toPos, toTarget);
  }

  // Leave bobOffset/bobVelocity as they are (don't snap to 0) — bobTarget=0
  // lets the existing spring ease any residual dip out smoothly.
  dipAmount = view.closeDistance * 0.04;
  bobTarget = 0;
  currentStiffness = SPRING_STIFFNESS_RISE;
  currentDamping = SPRING_DAMPING_RISE;

  applyZoomLimits();
  renderWordList();
}

// Places one instance of every loaded model on the wall (same z, spread
// across x/y in a grid, spaced by WALL_SPACING) and pre-computes each one's
// close-up framing. Keeps each model's manifest id around too, so the word
// list (below) can tell which wall object is currently focused.
function buildWall(entries) {
  const cols = Math.ceil(Math.sqrt(entries.length));
  const rows = Math.ceil(entries.length / cols);
  return entries.map(({ id, object }, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const wallPos = new THREE.Vector3(
      (col - (cols - 1) / 2) * WALL_SPACING,
      -(row - (rows - 1) / 2) * WALL_SPACING,
      0
    );
    const group = prepareObject(object, wallPos);
    scene.add(group);
    return { id, group, ...computeCloseView(group) };
  });
}

// Don't let the manual pan tween and user-driven dragging fight each other —
// finish the tween instantly and hand off to whichever drag is starting.
function finishPanTweenNow() {
  if (!panTween) return;
  camera.position.copy(panTween.toPos);
  controls.target.copy(panTween.toTarget);
  camera.lookAt(controls.target);
  currentZoomDistance = camera.position.distanceTo(controls.target);
  panTween = null;
}

function onInteractionDragStart() {
  dragging = true;
  finishPanTweenNow();
  bobTarget = dipAmount;
  currentStiffness = SPRING_STIFFNESS_RISE;
  currentDamping = SPRING_DAMPING_RISE;
}

function onInteractionDragEnd() {
  dragging = false;
  bobTarget = 0;
  currentStiffness = SPRING_STIFFNESS_FALL;
  currentDamping = SPRING_DAMPING_FALL;
}

// TrackballControls' own drag (debug mode's free camera) still fires these.
controls.addEventListener('start', onInteractionDragStart);
controls.addEventListener('end', onInteractionDragEnd);

// --- Drag-to-rotate-the-object (gallery mode only; debug mode instead free-
// roams the camera via TrackballControls, gated by controls.enabled) -------
const ROTATE_YAW_AXIS = new THREE.Vector3(0, 1, 0);
const ROTATE_PITCH_AXIS = new THREE.Vector3(1, 0, 0);
const _yawQuat = new THREE.Quaternion();
const _pitchQuat = new THREE.Quaternion();
let rotatePointerId = null;
let lastPointerX = 0;
let lastPointerY = 0;
// "Radians to apply this frame" — driven live by pointermove while dragging,
// then left to decay each frame (OBJECT_ROTATE_INERTIA_DAMPING) once
// released, so a flick keeps coasting briefly instead of stopping dead.
let objectRotVelYaw = 0;
let objectRotVelPitch = 0;

// World-space yaw/pitch turn of the focused object — world-space (not
// object-local) so the object always responds the same way to a given drag
// direction, regardless of how it's currently oriented.
function applyObjectRotation(yawDelta, pitchDelta) {
  if (currentObjectIndex < 0) return;
  const group = wallObjects[currentObjectIndex].group;
  _yawQuat.setFromAxisAngle(ROTATE_YAW_AXIS, yawDelta);
  _pitchQuat.setFromAxisAngle(ROTATE_PITCH_AXIS, pitchDelta);
  group.quaternion.premultiply(_yawQuat).premultiply(_pitchQuat);
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (debugMode || currentObjectIndex < 0 || rotatePointerId !== null) return;
  rotatePointerId = e.pointerId;
  lastPointerX = e.clientX;
  lastPointerY = e.clientY;
  objectRotVelYaw = 0;
  objectRotVelPitch = 0;
  renderer.domElement.setPointerCapture(e.pointerId);
  onInteractionDragStart();
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.pointerId !== rotatePointerId) return;
  const dx = e.clientX - lastPointerX;
  const dy = e.clientY - lastPointerY;
  lastPointerX = e.clientX;
  lastPointerY = e.clientY;
  const yawDelta = dx * OBJECT_ROTATE_SPEED;
  const pitchDelta = dy * OBJECT_ROTATE_SPEED;
  applyObjectRotation(yawDelta, pitchDelta);
  // Smoothed rather than the raw per-event delta, so inertia reflects the
  // recent drag rate instead of whatever the last (possibly tiny) move was.
  objectRotVelYaw = THREE.MathUtils.lerp(objectRotVelYaw, yawDelta, 0.5);
  objectRotVelPitch = THREE.MathUtils.lerp(objectRotVelPitch, pitchDelta, 0.5);
});
function endObjectRotateDrag(e) {
  if (e.pointerId !== rotatePointerId) return;
  rotatePointerId = null;
  onInteractionDragEnd();
}
renderer.domElement.addEventListener('pointerup', endObjectRotateDrag);
renderer.domElement.addEventListener('pointercancel', endObjectRotateDrag);

// Wheel dollies the camera toward/away from the focused object along its
// fixed viewing direction, clamped to the zoom limits from applyZoomLimits().
renderer.domElement.addEventListener(
  'wheel',
  (e) => {
    if (debugMode || currentObjectIndex < 0 || panTween) return;
    e.preventDefault();
    const view = wallObjects[currentObjectIndex];
    const factor = Math.exp(e.deltaY * WHEEL_ZOOM_SPEED);
    currentZoomDistance = THREE.MathUtils.clamp(currentZoomDistance * factor, controls.minDistance, controls.maxDistance);
    camera.position.copy(controls.target).addScaledVector(view.dir, currentZoomDistance);
    camera.lookAt(controls.target);
  },
  { passive: false }
);

function setDebugMode(on) {
  debugMode = on;
  panTween = null;
  rotatePointerId = null;
  controls.enabled = debugMode;
  if (debugMode) {
    // Same generic bounds the controls start with before any object is shown.
    controls.minDistance = 0.05;
    controls.maxDistance = 50;
  } else {
    applyZoomLimits();
  }
}

window.addEventListener('keydown', (e) => {
  if (e.key === '0') setDebugMode(!debugMode);
});

btnRandomObject.addEventListener('click', () => {
  focusObject(pickNextObjectIndex());
  // Restart the click-spin animation even on a rapid re-click: removing the
  // class doesn't take effect until the next reflow, so force one before
  // re-adding it — otherwise the browser just no-ops the "same" class add.
  btnRandomObject.classList.remove('spin');
  void btnRandomObject.offsetWidth;
  btnRandomObject.classList.add('spin');
});
btnRandomObject.addEventListener('animationend', () => btnRandomObject.classList.remove('spin'));

function loadModel(model) {
  return new Promise((resolve, reject) => {
    if (model.type === 'obj') {
      objLoader.load(
        BASE + model.mesh,
        (object) => {
          const material = buildMaterial(model.textures);
          object.traverse((child) => {
            if (child.isMesh) child.material = material;
          });
          resolve(object);
        },
        undefined,
        reject
      );
    } else {
      gltfLoader.load(BASE + model.mesh, (gltf) => resolve(gltf.scene), undefined, reject);
    }
  });
}

async function init() {
  const res = await fetch(BASE + 'models/manifest.json');
  const models = await res.json();

  if (!models.length) {
    statusEl.textContent = 'source 폴더에서 모델을 찾지 못했습니다.';
    return;
  }

  statusEl.textContent = '불러오는 중...';
  statusEl.style.display = 'block';

  const entries = await Promise.all(
    models.map((model) =>
      loadModel(model)
        .then((object) => ({ id: model.id, object }))
        .catch((err) => {
          console.error(err);
          return null;
        })
    )
  );

  const loaded = entries.filter(Boolean);
  if (!loaded.length) {
    statusEl.textContent = '모델을 불러오지 못했습니다.';
    return;
  }

  wallObjects = buildWall(loaded);
  focusObject(Math.floor(Math.random() * wallObjects.length), { instant: true });
  statusEl.style.display = 'none';
}

init();

window.addEventListener('resize', () => {
  camera.aspect = app.clientWidth / app.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(app.clientWidth, app.clientHeight);
  syncHudViewBox();
  // Unlike OrbitControls, TrackballControls caches the canvas's screen-space
  // bounds (for mapping pointer position to rotation) and needs this called
  // explicitly whenever those bounds change.
  controls.handleResize();
});

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsedTime += dt;

  if (!dragging && !debugMode && currentObjectIndex >= 0) {
    autoAdvanceTimer += dt;
    if (autoAdvanceTimer >= AUTO_ADVANCE_INTERVAL) focusObject(pickNextObjectIndex());
  }

  if (panTween) {
    updatePanTween();
  } else if (debugMode) {
    controls.update();
  }

  // Once the drag that was driving objectRotVel* live has ended, keep
  // spinning the object at that rate for a bit, decaying it toward 0 each
  // frame — the coast-to-a-stop a flick leaves behind.
  if (rotatePointerId === null && (objectRotVelYaw !== 0 || objectRotVelPitch !== 0)) {
    applyObjectRotation(objectRotVelYaw, objectRotVelPitch);
    objectRotVelYaw *= OBJECT_ROTATE_INERTIA_DAMPING;
    objectRotVelPitch *= OBJECT_ROTATE_INERTIA_DAMPING;
    if (Math.abs(objectRotVelYaw) < OBJECT_ROTATE_INERTIA_STOP) objectRotVelYaw = 0;
    if (Math.abs(objectRotVelPitch) < OBJECT_ROTATE_INERTIA_STOP) objectRotVelPitch = 0;
  }

  // Spring the Y offset toward bobTarget: rises on drag start, eases back down
  // (with a little overshoot) on release.
  const accel = (bobTarget - bobOffset) * currentStiffness - bobVelocity * currentDamping;
  bobVelocity += accel * dt;
  bobOffset += bobVelocity * dt;

  // Slow, smooth ambient drift — screen-space X/Y only (no Z, so it never
  // reads as a zoom), plus a barely-there rotational sway. Two out-of-phase
  // sines per channel so it never looks like a simple metronome pulse.
  const wt = elapsedTime * WIGGLE_SPEED;
  const wiggleX =
    currentZoomDistance * WIGGLE_POS_FACTOR * (0.6 * Math.sin(wt * 0.17 + 1.3) + 0.4 * Math.sin(wt * 0.071 + 4.1));
  const wiggleY =
    currentZoomDistance * WIGGLE_POS_FACTOR * (0.6 * Math.sin(wt * 0.13 + 2.7) + 0.4 * Math.sin(wt * 0.053 + 0.6));
  const wiggleYaw = WIGGLE_ROT_AMP * Math.sin(wt * 0.09 + 0.8);
  const wiggleTilt = WIGGLE_ROT_AMP * 0.7 * Math.sin(wt * 0.12 + 3.4);

  // Every object on the wall keeps spinning slowly around its own fixed random axis.
  for (const { group } of wallObjects) {
    group.rotateOnAxis(group.userData.spinAxis, group.userData.spinSpeed * dt);
  }

  // Nudge for this render only, then undo it — otherwise TrackballControls reads
  // the offset position back as the "real" camera on the next frame and it
  // compounds into runaway drift instead of a clean spring motion.
  camera.position.x += wiggleX;
  camera.position.y += bobOffset + wiggleY;
  camera.rotateY(wiggleYaw);
  camera.rotateX(wiggleTilt);

  renderer.render(scene, camera);

  // Read the live, wiggle-included position — still nudged at this point,
  // before the undo below — but only every COORD_UPDATE_INTERVAL seconds:
  // at full render fps the ambient sway makes the digits flicker too fast
  // to read, so this settles it to a steady ~12 updates/sec instead.
  if (elapsedTime - lastCoordUpdateTime >= COORD_UPDATE_INTERVAL) {
    lastCoordUpdateTime = elapsedTime;
    cameraXEl.textContent = camera.position.x.toFixed(5);
    cameraYEl.textContent = camera.position.y.toFixed(5);
  }

  camera.rotateX(-wiggleTilt);
  camera.rotateY(-wiggleYaw);
  camera.position.x -= wiggleX;
  camera.position.y -= bobOffset + wiggleY;
});
