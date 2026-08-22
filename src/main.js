import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';

// ============================================================================
// Look & feel tuning — kept together here since these get tweaked a lot.
// ============================================================================
const YELLOW_COLOR = 0xffe600; // the flat "노란 단색" used for the yellow stage
const BG_YELLOW_COLOR = 0xfff075; // background/porthole-frame color outside look-mode 3, and mode 3's stage-3 color
const BG_BLACK_COLOR = 0x090909; // look-mode 3's background/porthole-frame color during stages 1-2
const RENDER_EXPOSURE = 2.5; // renderer.toneMappingExposure — lower = darker overall, less washed-out/ivory highlights
// Look-mode 1's roughness: lower = tighter, brighter specular highlight from
// the key/fill lights (more visible "shine"); higher = softer/duller, closer
// to no highlight at all (1.0 is roughly what look-mode 1 used to be).
const YELLOW_LIT_ROUGHNESS = 0.35;
// Look-mode 1's shaded/dark side would otherwise just fade toward a dull,
// desaturated gray-yellow as light falls off. This emissive accent (usually
// a deeper, more saturated version of YELLOW_COLOR) adds a light-independent
// floor of color, so the shadow side stays rich/colorful instead of muddy.
const YELLOW_SHADOW_COLOR = 0xE8A000;
const YELLOW_SHADOW_INTENSITY = 0.25; // 0 = no boost, higher = richer/brighter shadow
// Ambient light lands equally on every face regardless of orientation, so
// raising it lifts the shadow/unlit side of objects toward a flatter, more
// matte look without touching the side already lit by the key/fill lights.
const AMBIENT_LIGHT_INTENSITY = 0.6;

// Stage-cycle tuning: each shown object goes through 3 stages of
// STAGE_DURATION seconds each — (1) yellow + close-up, (2) yellow + whole
// object, (3) original texture + whole object — then hands off to a new
// random object (never repeating the one just shown).
const STAGE_DURATION = 3; // seconds per stage
const CLOSE_ZOOM_MULTIPLIER = 0.3; // stage-1 close-up distance, x the object's bounding radius
// Stage-1's distance is never allowed under this, x the object's bounding
// radius (half the bounding box's diagonal — a sphere guaranteed to fully
// contain the geometry from any angle) — so however tight CLOSE_ZOOM_MULTIPLIER
// is set, the initial camera placement can't end up inside the object.
const MIN_SAFE_ZOOM_MULTIPLIER = 1.05;
const WHOLE_OBJECT_ZOOM_MARGIN = 1.25; // stage-2/3 whole-object distance, x the FOV-fit distance
// How far the user can zoom in/out from whichever stage's target distance,
// as a +/-fraction of it.
const ZOOM_RANGE_FRACTION = 0.1;
const ZOOM_STAGE_TRANSITION_DURATION = 0.8; // seconds, eased zoom-out leaving stage 1
// How much camera rotation a drag produces (TrackballControls' rotateSpeed) —
// this is purely the user-driven drag-to-rotate rate, not the objects' own
// idle self-spin.
const DRAG_ROTATE_SPEED = 2.5;
// ============================================================================

const app = document.getElementById('app');
const statusEl = document.getElementById('status');
const bubbleCanvas = document.getElementById('bubbles');
const bubbleCtx = bubbleCanvas.getContext('2d');
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

// TrackballControls instead of OrbitControls: OrbitControls clamps its polar
// angle to [0, pi] (can't rotate past looking straight up/down), which reads
// as rotation suddenly "getting stuck" if you keep dragging the same way.
// TrackballControls rotates via axis-angle/quaternion instead of spherical
// coordinates, so there's no polar singularity — rotation stays free in any
// direction indefinitely.
const controls = new TrackballControls(camera, renderer.domElement);
controls.noPan = true;
controls.staticMoving = false;
controls.dynamicDampingFactor = 0.08; // roughly analogous to OrbitControls' dampingFactor
controls.rotateSpeed = DRAG_ROTATE_SPEED;
// Real min/max are set per-stage in applyZoomLimits(), scaled to that stage's target distance.
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

// Click-triggered bubbles, drawn on a plain 2D overlay canvas above the WebGL one.
let bubbleDpr = 1;
function resizeBubbleCanvas() {
  bubbleDpr = window.devicePixelRatio || 1;
  bubbleCanvas.width = app.clientWidth * bubbleDpr;
  bubbleCanvas.height = app.clientHeight * bubbleDpr;
  bubbleCtx.setTransform(bubbleDpr, 0, 0, bubbleDpr, 0, 0);
}
resizeBubbleCanvas();

const bubbles = [];
function spawnBubbles(count = 10) {
  const width = app.clientWidth;
  const height = app.clientHeight;
  for (let i = 0; i < count; i++) {
    bubbles.push({
      x: randomRange(width * 0.15, width * 0.85),
      y: height + randomRange(0, 10),
      radius: randomRange(9, 22),
      riseSpeed: randomRange(70, 140),
      wobbleAmp: randomRange(6, 18),
      wobbleFreq: randomRange(1.5, 3),
      wobblePhase: randomRange(0, Math.PI * 2),
      age: 0,
      maxAge: randomRange(1.8, 3),
    });
  }
}

function updateAndDrawBubbles(dt) {
  const height = app.clientHeight;
  bubbleCtx.clearRect(0, 0, app.clientWidth, height);
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i];
    b.age += dt;
    if (b.age >= b.maxAge) {
      bubbles.splice(i, 1);
      continue;
    }
    b.y -= b.riseSpeed * dt;
    const drawX = b.x + Math.sin(b.wobblePhase + b.age * b.wobbleFreq) * b.wobbleAmp;
    const lifeT = b.age / b.maxAge;
    const fadeIn = Math.min(1, b.age / 0.2);
    const fadeOut = 1 - Math.max(0, (lifeT - 0.7) / 0.3);
    const alpha = fadeIn * fadeOut;

    bubbleCtx.save();
    bubbleCtx.shadowColor = 'rgba(255, 255, 255, 0.9)';
    bubbleCtx.shadowBlur = 12;

    bubbleCtx.beginPath();
    bubbleCtx.arc(drawX, b.y, b.radius, 0, Math.PI * 2);
    bubbleCtx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.55})`;
    bubbleCtx.fill();
    bubbleCtx.lineWidth = 2;
    bubbleCtx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
    bubbleCtx.stroke();

    bubbleCtx.beginPath();
    bubbleCtx.arc(drawX - b.radius * 0.35, b.y - b.radius * 0.35, b.radius * 0.3, 0, Math.PI * 2);
    bubbleCtx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    bubbleCtx.fill();
    bubbleCtx.restore();
  }
}

// A plain click (no drag) spawns bubbles; a rotate-drag should not.
let pointerDownPos = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  pointerDownPos = { x: e.clientX, y: e.clientY, t: performance.now() };
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!pointerDownPos) return;
  const dist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
  const duration = performance.now() - pointerDownPos.t;
  pointerDownPos = null;
  if (dist < 12 && duration < 600) spawnBubbles();
});

const clock = new THREE.Clock();
let elapsedTime = 0;
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

// Normalize the object to the target size and center its pivot, then wrap it
// in a group at the world origin with a random orientation and its own slow
// spin. The wrapping is what makes rotation not shift the object's visual
// center: the mesh is centered on the group's own origin, so spinning the
// group in place never moves that origin.
function prepareObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  const scale = TARGET_SIZE / maxDim;
  object.scale.setScalar(scale);
  object.position.copy(center).multiplyScalar(-scale);

  const group = new THREE.Group();
  group.add(object);
  group.rotation.set(randomRange(0, Math.PI * 2), randomRange(0, Math.PI * 2), randomRange(0, Math.PI * 2));

  // Keeps spinning slowly around its own random axis for as long as it's shown.
  group.userData.spinAxis = randomAxis();
  group.userData.spinSpeed = randomRange(0.015, 0.05);

  prepareFilterMaterials(group);
  return group;
}

// clone()'d objects share one material per mesh by default, so tinting a
// single instance would tint every repeat of that same food. Give each mesh
// its own material, plus both yellow-stage twins (flat and lit, see below)
// ready to swap in later.
function prepareFilterMaterials(group) {
  group.traverse((child) => {
    if (!child.isMesh) return;
    const normal = child.material.clone();
    child.material = normal;
    child.userData.normalMaterial = normal;
    child.userData.yellowMaterialFlat = buildYellowMaterialFlat();
    child.userData.yellowMaterialLit = buildYellowMaterialLit(normal);
  });
}

// A genuine flat-color THREE texture (not just a material.color tweak) —
// a tiny canvas filled solid, used both for 'solid' mode and as the
// immediate fallback in 'filter' mode before the real bake is ready.
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

// Look mode 2 (and 3, which reuses it): fully unlit (MeshBasicMaterial, not
// a clone of the PBR material) — scene lighting (ambient/key/fill) never
// touches it, so it can't be brightened or desaturated by however those are
// tuned. It also opts out of tone mapping (toneMapped = false), which
// otherwise runs every color through the ACES curve — even a "correctly
// exposed" color doesn't come back out unchanged. Between the two, what's on
// screen is as close as this pipeline can get to YELLOW_COLOR's literal hex
// value, with zero surface shading (completely flat).
function buildYellowMaterialFlat() {
  const yellow = new THREE.MeshBasicMaterial({
    map: createSolidColorTexture(YELLOW_COLOR),
    color: 0xffffff, // the texture itself carries the color
  });
  yellow.toneMapped = false;
  return yellow;
}

// Look mode 1: a lit PBR material carrying over the original material's
// normal/bump maps, so the scene's lights pick up the object's real surface
// detail (wrinkles, dents, etc.) on top of the flat yellow color, plus the
// specular highlight from YELLOW_LIT_ROUGHNESS.
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

function setYellowFilter(group, enabled) {
  group.traverse((child) => {
    if (!child.isMesh) return;
    if (!enabled) {
      child.material = child.userData.normalMaterial;
      return;
    }
    child.material = lookMode === 1 ? child.userData.yellowMaterialLit : child.userData.yellowMaterialFlat;
  });
}

const _surfaceRayOrigin = new THREE.Vector3();
const _surfaceRayDir = new THREE.Vector3();
const _surfaceRaycaster = new THREE.Raycaster();

// How far the object's *real* surface is from `center` along `dir`, found by
// raycasting against the actual geometry from well outside it. Tighter than
// the conservative bounding-sphere radius for most viewing angles on
// non-spherical shapes, while still guaranteed not to clip through the mesh.
// Falls back to boundingRadius if the ray somehow doesn't hit anything.
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

// Everything needed to run one object's 3-stage cycle: a fixed center/viewing
// direction (only the distance along it changes between stages) plus the two
// distances stage 1 and stages 2/3 sit at.
function computeCycleView(object) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const boundingRadius = size.length() / 2;
  const fitDistance = maxDim / (2 * Math.tan((Math.PI * camera.fov) / 360));

  const theta = randomRange(0, Math.PI * 2);
  const phi = randomRange(Math.PI * 0.3, Math.PI * 0.7);
  const dir = new THREE.Vector3(
    Math.sin(phi) * Math.cos(theta),
    Math.cos(phi),
    Math.sin(phi) * Math.sin(theta)
  );

  // MIN_SAFE_ZOOM_MULTIPLIER is applied against the *real* surface distance
  // along this specific direction (not the one-size-fits-all bounding
  // sphere), so CLOSE_ZOOM_MULTIPLIER actually has room to pull the framing
  // in tight on most objects/angles instead of always losing to a floor
  // sized for the worst-case corner-on view.
  const realSurfaceDistance = surfaceDistanceAlong(object, center, dir, boundingRadius);
  const closeDistance = Math.max(boundingRadius * CLOSE_ZOOM_MULTIPLIER, realSurfaceDistance * MIN_SAFE_ZOOM_MULTIPLIER);
  const wholeDistance = fitDistance * WHOLE_OBJECT_ZOOM_MARGIN;

  return { center, dir, closeDistance, wholeDistance, fitDistance, boundingRadius };
}

// --- Single-object stage cycle state ---------------------------------------
let templates = [];
let currentGroup = null;
let currentTemplateIndex = -1;
let cycleView = null;
let stageIndex = 0; // 0: yellow + close-up, 1: yellow + whole object, 2: original texture + whole object
let activeElapsed = 0; // seconds, excludes time spent dragging or in debug mode
let stageStartActive = 0; // activeElapsed value when the current object's cycle began
let dragging = false;
let zoomTween = null; // { dir, fromDist, toDist, start } — eased distance-only tween leaving stage 1

// Debug mode (toggled with the '0' key): free camera, stage cycle paused, no
// zoom limits. Default mode (the normal stage cycle) is what the app starts in.
let debugMode = false;

// Look mode (toggled with the '1'/'2'/'3' keys, mutually exclusive):
//   1 — yellow stage lit smoothly (buildYellowMaterialLit), static yellow background (default)
//   2 — yellow stage fully flat (buildYellowMaterialFlat), static yellow background
//   3 — same flat material as mode 2, but the background/porthole-frame color
//       tracks the object's own stage: black during stages 1-2, yellow at stage 3
let lookMode = 1;

// Applies the background/porthole-frame color for the current look mode +
// stage: static yellow outside mode 3, or stage-synced black/yellow in it.
function applyBackground() {
  const hex = lookMode === 3 && stageIndex <= 1 ? BG_BLACK_COLOR : BG_YELLOW_COLOR;
  scene.background.setHex(hex);
  if (hud1Frame) hud1Frame.setAttribute('fill', `#${hex.toString(16).padStart(6, '0')}`);
}

function setLookMode(mode) {
  if (lookMode === mode) return;
  lookMode = mode;
  // If the object is currently showing a yellow stage, swap its material
  // immediately instead of waiting for the next stage transition.
  if (currentGroup && stageIndex <= 1) setYellowFilter(currentGroup, true);
  applyBackground();
}

function stageTargetDistance() {
  return stageIndex === 0 ? cycleView.closeDistance : cycleView.wholeDistance;
}

// How far the user can zoom in/out from whichever stage's target distance —
// see ZOOM_RANGE_FRACTION above.
function applyZoomLimits() {
  if (debugMode || !cycleView) return;
  const target = stageTargetDistance();
  controls.minDistance = target * (1 - ZOOM_RANGE_FRACTION);
  controls.maxDistance = target * (1 + ZOOM_RANGE_FRACTION);
}

function startZoomTween(toDist) {
  const dir = camera.position.clone().sub(controls.target);
  const fromDist = dir.length() || toDist;
  dir.normalize();
  zoomTween = { dir, fromDist, toDist, start: elapsedTime };
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Advances the active zoom tween; called instead of controls.update() while
// one is in progress so TrackballControls doesn't fight the manual tween. Only
// the distance along the fixed viewing direction changes — the object itself
// never moves, so no curve/bounce is needed here, unlike the old cross-object
// flights this replaced.
function updateZoomTween() {
  const t = Math.min(1, (elapsedTime - zoomTween.start) / ZOOM_STAGE_TRANSITION_DURATION);
  const dist = THREE.MathUtils.lerp(zoomTween.fromDist, zoomTween.toDist, easeInOutCubic(t));
  camera.position.copy(controls.target).addScaledVector(zoomTween.dir, dist);
  camera.lookAt(controls.target);
  currentZoomDistance = dist;
  if (t >= 1) zoomTween = null;
}

function pickNextTemplateIndex() {
  if (templates.length <= 1) return 0;
  let idx;
  do {
    idx = Math.floor(Math.random() * templates.length);
  } while (idx === currentTemplateIndex);
  return idx;
}

// Swap in a new random object (never the one just shown) and start its cycle
// fresh at stage 0 (yellow + close-up), cutting the camera straight there.
function showNextObject() {
  if (currentGroup) scene.remove(currentGroup);

  currentTemplateIndex = pickNextTemplateIndex();
  const instance = templates[currentTemplateIndex].clone(true);
  currentGroup = prepareObject(instance);
  scene.add(currentGroup);
  setYellowFilter(currentGroup, true);

  cycleView = computeCycleView(currentGroup);
  stageIndex = 0;
  stageStartActive = activeElapsed;
  zoomTween = null;
  applyBackground();

  camera.near = cycleView.closeDistance / 100;
  camera.far = cycleView.fitDistance * 100;
  camera.updateProjectionMatrix();

  controls.target.copy(cycleView.center);
  camera.position.copy(cycleView.center).addScaledVector(cycleView.dir, cycleView.closeDistance);
  // TrackballControls lets the user roll the camera's up vector freely while
  // examining an object (that's what makes rotation never get stuck) — reset
  // it here so every new object starts from a clean, upright framing instead
  // of carrying over whatever roll was left from the previous one.
  camera.up.set(0, 1, 0);
  camera.lookAt(controls.target);
  currentZoomDistance = cycleView.closeDistance;

  // Leave bobOffset/bobVelocity as they are (don't snap to 0) — bobTarget=0
  // lets the existing spring ease any residual dip out smoothly.
  dipAmount = cycleView.closeDistance * 0.04;
  bobTarget = 0;
  currentStiffness = SPRING_STIFFNESS_RISE;
  currentDamping = SPRING_DAMPING_RISE;

  applyZoomLimits();
}

controls.addEventListener('start', () => {
  dragging = true;
  // Don't let the manual zoom tween and user-driven orbiting fight each
  // other — finish the tween instantly and hand off to TrackballControls.
  if (zoomTween) {
    camera.position.copy(controls.target).addScaledVector(zoomTween.dir, zoomTween.toDist);
    camera.lookAt(controls.target);
    currentZoomDistance = zoomTween.toDist;
    zoomTween = null;
  }
  bobTarget = dipAmount;
  currentStiffness = SPRING_STIFFNESS_RISE;
  currentDamping = SPRING_DAMPING_RISE;
});
controls.addEventListener('end', () => {
  dragging = false;
  bobTarget = 0;
  currentStiffness = SPRING_STIFFNESS_FALL;
  currentDamping = SPRING_DAMPING_FALL;
});

function setDebugMode(on) {
  debugMode = on;
  zoomTween = null;
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
  else if (e.key === '1') setLookMode(1);
  else if (e.key === '2') setLookMode(2);
  else if (e.key === '3') setLookMode(3);
});

// Steps the stage timer (paused while dragging or in debug mode) and either
// runs the zoom tween or hands control to TrackballControls for the frame.
function updateCycle(dt) {
  if (!dragging && !debugMode) activeElapsed += dt;

  if (!debugMode && cycleView) {
    const t = activeElapsed - stageStartActive;
    if (t >= STAGE_DURATION * 3) {
      showNextObject();
    } else {
      const newStage = Math.min(2, Math.floor(t / STAGE_DURATION));
      if (newStage !== stageIndex) {
        stageIndex = newStage;
        if (stageIndex === 1) startZoomTween(cycleView.wholeDistance);
        if (stageIndex === 2) setYellowFilter(currentGroup, false);
        applyZoomLimits();
        applyBackground();
      }
    }
  }

  if (zoomTween) {
    updateZoomTween();
  } else {
    controls.update();
  }
}

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

  const objects = await Promise.all(
    models.map((model) =>
      loadModel(model).catch((err) => {
        console.error(err);
        return null;
      })
    )
  );

  templates = objects.filter(Boolean);
  if (!templates.length) {
    statusEl.textContent = '모델을 불러오지 못했습니다.';
    return;
  }

  showNextObject();
  statusEl.style.display = 'none';
}

init();

window.addEventListener('resize', () => {
  camera.aspect = app.clientWidth / app.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(app.clientWidth, app.clientHeight);
  resizeBubbleCanvas();
  // Unlike OrbitControls, TrackballControls caches the canvas's screen-space
  // bounds (for mapping pointer position to rotation) and needs this called
  // explicitly whenever those bounds change.
  controls.handleResize();
});

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsedTime += dt;

  updateCycle(dt);

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

  // The object keeps spinning slowly around its own fixed random axis.
  if (currentGroup) {
    currentGroup.rotateOnAxis(currentGroup.userData.spinAxis, currentGroup.userData.spinSpeed * dt);
  }

  // Nudge for this render only, then undo it — otherwise TrackballControls reads
  // the offset position back as the "real" camera on the next frame and it
  // compounds into runaway drift instead of a clean spring motion.
  camera.position.x += wiggleX;
  camera.position.y += bobOffset + wiggleY;
  camera.rotateY(wiggleYaw);
  camera.rotateX(wiggleTilt);

  renderer.render(scene, camera);

  camera.rotateX(-wiggleTilt);
  camera.rotateY(-wiggleYaw);
  camera.position.x -= wiggleX;
  camera.position.y -= bobOffset + wiggleY;

  updateAndDrawBubbles(dt);
});
