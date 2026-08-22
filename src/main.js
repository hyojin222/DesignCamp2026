import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './hud.js';

// ============================================================================
// Look & feel tuning — kept together here since these get tweaked a lot.
// ============================================================================
const YELLOW_FILTER_FRACTION = 1 / 3; // portion of all objects given the treatment
const YELLOW_MODE = 'filter'; // 'filter' = tint over the texture, 'solid' = flat color, no texture
const YELLOW_FILTER_COLOR = 0xFFEA47; // tint color used in 'filter' mode
const YELLOW_FILTER_STRENGTH = 1.0; // 0 = no visible tint, 1 = fully replaced by YELLOW_FILTER_COLOR
const YELLOW_SOLID_COLOR = 0xFFEA47; // flat color used in 'solid' mode
const RENDER_EXPOSURE = 0.7; // renderer.toneMappingExposure — lower = darker overall, less washed-out/ivory highlights
// Default-mode focus distance, as a multiple of the object's bounding radius.
const DEFAULT_ZOOM_MULTIPLIER = 0.5;
// In default mode, how far the user can zoom in/out from that default
// distance, as a +/-fraction of it (see computeZoomLimits).
const ZOOM_RANGE_FRACTION = 0.2;
// ============================================================================

const app = document.getElementById('app');
const statusEl = document.getElementById('status');
const bubbleCanvas = document.getElementById('bubbles');
const bubbleCtx = bubbleCanvas.getContext('2d');

const scene = new THREE.Scene();
// scene.background = new THREE.Color(0x090909);
scene.background = new THREE.Color(0xFFEA47);

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

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.rotateSpeed = 0.8;
// Real min/max are set per-focus in applyFocusState(), scaled to that object's zoom.
controls.minDistance = 0.05;
controls.maxDistance = 50;

scene.add(new THREE.AmbientLight(0xffffff, 1.2));
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

// Auto-tour: focus one object at a time, filling the frame, and hand off to a
// random different one every AUTO_SWITCH_MS via an eased camera transition.
// Right after the user drags, the next hand-off comes sooner (POST_DRAG_SWITCH_MS).
const AUTO_SWITCH_MS = 15000;
const POST_DRAG_SWITCH_MS = 5000;
const TRANSITION_DURATION = 3.6;
let placedObjects = [];
let focusedObject = null;
let transition = null;
let autoSwitchTimer = null;

// Debug mode (toggled with the '0' key): free camera, no auto-switching, no
// zoom limits. Default mode (the normal auto-tour) is what the app starts in.
let debugMode = false;

controls.addEventListener('start', () => {
  transition = null;
  clearTimeout(autoSwitchTimer);
  bobTarget = dipAmount;
  currentStiffness = SPRING_STIFFNESS_RISE;
  currentDamping = SPRING_DAMPING_RISE;
});
controls.addEventListener('end', () => {
  bobTarget = 0;
  currentStiffness = SPRING_STIFFNESS_FALL;
  currentDamping = SPRING_DAMPING_FALL;
  if (!debugMode) scheduleAutoSwitch(POST_DRAG_SWITCH_MS);
});

function setDebugMode(on) {
  debugMode = on;
  clearTimeout(autoSwitchTimer);
  if (debugMode) {
    transition = null;
    // Same generic bounds the controls start with before any focus is applied.
    controls.minDistance = 0.05;
    controls.maxDistance = 50;
  } else {
    if (focusedObject) {
      const view = computeFocusView(focusedObject);
      const limits = computeZoomLimits(view);
      controls.minDistance = limits.min;
      controls.maxDistance = limits.max;
    }
    scheduleAutoSwitch();
  }
}

window.addEventListener('keydown', (e) => {
  if (e.key === '0') setDebugMode(!debugMode);
});

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

// 30 objects total, repeating the available types as needed, scattered at
// random non-overlapping positions (including the interior, not just the
// shell) throughout a cube, each with a fully random orientation.
const CUBE_HALF = 5.5;
const TARGET_SIZE = 2.2;
const TOTAL_COUNT = 30;
const MIN_SEPARATION = TARGET_SIZE * 1.05;
// How far outside the cluster the camera's flight path bulges out to, so it
// swings around other objects instead of cutting straight through them.
const ORBIT_RADIUS = CUBE_HALF * Math.sqrt(3) * 1.4;

function randomPointInCube(half) {
  return new THREE.Vector3(randomRange(-half, half), randomRange(-half, half), randomRange(-half, half));
}

function randomAxis() {
  const axis = new THREE.Vector3(randomRange(-1, 1), randomRange(-1, 1), randomRange(-1, 1));
  return axis.lengthSq() < 1e-6 ? axis.set(0, 1, 0) : axis.normalize();
}

// Normalize the object to the target size, then wrap it in a group placed at
// a random, non-overlapping point inside the cube with a random orientation.
// The wrapping is what makes rotation not shift the object's visual center:
// the mesh is centered on the group's own origin, so spinning the group in
// place never moves that origin away from the point it was given.
function placeInCube(object, placedPositions) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  const scale = TARGET_SIZE / maxDim;
  object.scale.setScalar(scale);
  object.position.copy(center).multiplyScalar(-scale);

  const group = new THREE.Group();
  group.add(object);

  let point = randomPointInCube(CUBE_HALF);
  for (let attempt = 0; attempt < 300; attempt++) {
    const candidate = randomPointInCube(CUBE_HALF);
    if (placedPositions.every((p) => p.distanceTo(candidate) >= MIN_SEPARATION)) {
      point = candidate;
      break;
    }
  }
  placedPositions.push(point);
  group.position.copy(point);

  group.rotation.set(randomRange(0, Math.PI * 2), randomRange(0, Math.PI * 2), randomRange(0, Math.PI * 2));

  // Keeps spinning slowly around its own random axis for as long as it exists.
  group.userData.spinAxis = randomAxis();
  group.userData.spinSpeed = randomRange(0.015, 0.05);

  prepareFilterMaterials(group);

  return group;
}

// clone()'d objects share one material per mesh by default, so tinting a
// single instance would tint every repeat of that same food. Give each mesh
// its own material, plus a "special" twin (filter tint or solid color,
// per YELLOW_MODE above) ready to swap in later.
function prepareFilterMaterials(group) {
  group.traverse((child) => {
    if (!child.isMesh) return;
    const normal = child.material.clone();
    child.material = normal;
    child.userData.normalMaterial = normal;
    child.userData.yellowMaterial = buildYellowMaterial(normal);
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

// Draws the object's real texture onto a canvas, then paints a semi-opaque
// yellow rectangle over it (alpha = strength) and hands back the flattened
// result as a new texture — an actual "yellow texture layered on the
// existing texture", not a shader-level tint. Waits for the source image if
// it hasn't finished loading yet.
function bakeYellowOverlayTexture(baseTexture, hexColor, strength, onReady) {
  const img = baseTexture.image;
  if (!img) return;
  const bake = () => {
    const w = img.naturalWidth || img.width || 512;
    const h = img.naturalHeight || img.height || 512;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    ctx.globalAlpha = strength;
    ctx.fillStyle = `#${new THREE.Color(hexColor).getHexString()}`;
    ctx.fillRect(0, 0, w, h);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = baseTexture.colorSpace;
    texture.wrapS = baseTexture.wrapS;
    texture.wrapT = baseTexture.wrapT;
    texture.repeat.copy(baseTexture.repeat);
    onReady(texture);
  };
  if (img.complete || img.videoWidth) bake();
  else img.addEventListener('load', bake, { once: true });
}

function buildYellowMaterial(normal) {
  const yellow = normal.clone();
  yellow.color.set(0xffffff); // the texture itself carries the color now

  if (YELLOW_MODE === 'solid') {
    // Texture removed entirely — a flat generated color texture instead.
    yellow.map = createSolidColorTexture(YELLOW_SOLID_COLOR);
    return yellow;
  }

  // Filter mode: start with a plain tinted texture immediately (so there's
  // always a real texture in place, even before the source image is ready),
  // then swap in the true "yellow layered over the existing texture" bake
  // once the original image has actually finished loading.
  const fallbackColor = normal.color.clone().lerp(new THREE.Color(YELLOW_FILTER_COLOR), YELLOW_FILTER_STRENGTH);
  yellow.map = createSolidColorTexture(fallbackColor.getHex());
  if (normal.map) {
    bakeYellowOverlayTexture(normal.map, YELLOW_FILTER_COLOR, YELLOW_FILTER_STRENGTH, (baked) => {
      yellow.map = baked;
      yellow.needsUpdate = true;
    });
  }
  return yellow;
}

function setYellowFilter(group, enabled) {
  group.traverse((child) => {
    if (!child.isMesh) return;
    child.material = enabled ? child.userData.yellowMaterial : child.userData.normalMaterial;
  });
}

// Re-rolls which ~1/3 of the objects are wearing the yellow filter.
function shuffleYellowFilters() {
  const count = Math.round(placedObjects.length * YELLOW_FILTER_FRACTION);
  const shuffled = [...placedObjects].sort(() => Math.random() - 0.5);
  for (const obj of placedObjects) setYellowFilter(obj, false);
  for (let i = 0; i < count; i++) setYellowFilter(shuffled[i], true);
}

function pickRandomObject(exclude) {
  if (placedObjects.length === 0) return null;
  if (placedObjects.length === 1) return placedObjects[0];
  let candidate;
  do {
    candidate = placedObjects[Math.floor(Math.random() * placedObjects.length)];
  } while (candidate === exclude);
  return candidate;
}

// Where the camera should sit to fill the frame with one object, from a random angle.
function computeFocusView(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  const fitDistance = maxDim / (2 * Math.tan((Math.PI * camera.fov) / 360));

  // The object's real bounding-sphere radius (half the box's diagonal, so it
  // fully contains every corner — half of maxDim alone would still let the
  // camera clip through corners on non-cubic shapes), so the camera is
  // mathematically guaranteed to sit outside the geometry instead of just
  // being placed at some fraction of fitDistance that could land inside it.
  // The default framing distance IS the closest safe distance (the max
  // zoom-in bound below is derived from this same value), so focusing on an
  // object starts already fully zoomed in on it.
  const boundingRadius = size.length() / 2;
  const zoomDistance = boundingRadius * DEFAULT_ZOOM_MULTIPLIER;

  const theta = randomRange(0, Math.PI * 2);
  const phi = randomRange(Math.PI * 0.3, Math.PI * 0.7);

  const position = new THREE.Vector3(
    center.x + zoomDistance * Math.sin(phi) * Math.cos(theta),
    center.y + zoomDistance * Math.cos(phi),
    center.z + zoomDistance * Math.sin(phi) * Math.sin(theta)
  );

  return { position, target: center, zoomDistance, fitDistance, boundingRadius };
}

// How far in/out the user can zoom in default mode: +/-ZOOM_RANGE_FRACTION
// around the current default framing distance, so pinch/scroll zoom always
// has real headroom in both directions from wherever DEFAULT_ZOOM_MULTIPLIER
// puts the default. No anti-clip floor here by design — DEFAULT_ZOOM_MULTIPLIER
// can intentionally sit closer than the object's bounding radius for a tight
// close-up default, and the +/-20% range follows it there.
function computeZoomLimits(view) {
  return {
    min: view.zoomDistance * (1 - ZOOM_RANGE_FRACTION),
    max: view.zoomDistance * (1 + ZOOM_RANGE_FRACTION),
  };
}

// Apply a focus view's distances/limits/spring state once the camera is actually there.
function applyFocusState(view) {
  camera.near = view.zoomDistance / 100;
  camera.far = view.fitDistance * 100;
  camera.updateProjectionMatrix();

  // How far in/out the user can zoom from the focused framing — see computeZoomLimits.
  if (!debugMode) {
    const limits = computeZoomLimits(view);
    controls.minDistance = limits.min;
    controls.maxDistance = limits.max;
  }

  // Leave bobOffset/bobVelocity as they are (don't snap to 0) — bobTarget=0
  // lets the existing spring ease any residual dip out smoothly instead of
  // cutting to it, which is what caused the little jerk on arrival.
  dipAmount = view.zoomDistance * 0.04;
  bobTarget = 0;
  currentStiffness = SPRING_STIFFNESS_RISE;
  currentDamping = SPRING_DAMPING_RISE;

  // So the ambient wiggle's amplitude stays proportional at any zoom level.
  currentZoomDistance = view.zoomDistance;
}

// Switch focus to one object, filling the frame with it from a random angle.
// The very first focus (animate=false) just cuts there; every later one eases
// the camera over from wherever it currently is.
function focusOnObject(object, animate) {
  const view = computeFocusView(object);
  focusedObject = object;
  shuffleYellowFilters();

  if (!animate) {
    camera.position.copy(view.position);
    controls.target.copy(view.target);
    applyFocusState(view);
    controls.update();
    return;
  }

  const fromPos = camera.position.clone();

  // Curve the flight path outward (a quadratic Bezier control point pushed
  // away from the cluster center) instead of a straight line, so the camera
  // swings around the other objects on its way instead of clipping through
  // them. Degenerate case (from/to roughly on top of each other): nudge the
  // control point off to the side so the curve still has some bulge.
  const mid = fromPos.clone().lerp(view.position, 0.5);
  const outDir = mid.lengthSq() > 1e-6 ? mid.normalize() : new THREE.Vector3(1, 0.4, 0).normalize();
  const control = outDir.multiplyScalar(ORBIT_RADIUS);

  // The direction the camera is travelling in right as it reaches the
  // destination (the curve's tangent at t=1) — the back/bounce wobble below
  // moves straight along this line, it does not re-walk the curve itself.
  const arrivalDir = view.position.clone().sub(control);
  if (arrivalDir.lengthSq() < 1e-6) arrivalDir.copy(view.position).sub(fromPos);
  if (arrivalDir.lengthSq() < 1e-6) arrivalDir.set(0, 1, 0);
  arrivalDir.normalize();

  transition = {
    fromPos,
    fromTarget: controls.target.clone(),
    fromZoomDistance: currentZoomDistance,
    control,
    arrivalDir,
    // Scaled to how far this particular trip is, so the overshoot is a
    // proportional "one extra step past the destination" like (0,3)->(1,6)-
    // >(3,12)->(2,9) rather than a fixed amount unrelated to the distance.
    travelDistance: fromPos.distanceTo(view.position),
    toPos: view.position,
    toTarget: view.target,
    view,
    start: elapsedTime,
  };
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// A smooth multi-bounce signal — zero at t=0 and t=1 (a sine "window" so it
// never disturbs the exact start/end position), riding a higher-frequency
// sine so it swings past and back more than once. The window is symmetric
// (mirrored around the midpoint), so the swing arriving at the end reads
// just as clearly as the one leaving the start, instead of fading out.
const BOUNCE_FREQ = 5; // integer, and >=5 so at least 2 full swings land right at the arrival end
function bounceSignal(t) {
  const window = Math.sin(Math.PI * t);
  const swing = Math.sin(BOUNCE_FREQ * Math.PI * t);
  return window * swing;
}

function quadraticBezier(p0, p1, p2, t, out) {
  const mt = 1 - t;
  const a = mt * mt;
  const b = 2 * mt * t;
  const c = t * t;
  return out.set(
    a * p0.x + b * p1.x + c * p2.x,
    a * p0.y + b * p1.y + c * p2.y,
    a * p0.z + b * p1.z + c * p2.z
  );
}

const _transitionPos = new THREE.Vector3();
const BOUNCE_AXIS_LIMIT = 20; // hard cap per-axis, world units

// Advances the active camera transition; called instead of controls.update()
// while one is in progress so OrbitControls doesn't fight the manual tween.
function updateTransition() {
  const t = Math.min(1, (elapsedTime - transition.start) / TRANSITION_DURATION);

  // Travel the curved (orbit-avoiding) path with a plain smooth ease — no
  // overshoot here, so the path itself is only ever walked forward once.
  const curveT = easeInOutCubic(t);
  quadraticBezier(transition.fromPos, transition.control, transition.toPos, curveT, _transitionPos);

  // Layer a straight-line back/bounce wobble on top, along the direction the
  // camera arrives from — zero at both ends (t=0 and t=1), so it never
  // changes the start or the exact final position, only the path between.
  const bounce = bounceSignal(t);
  const bounceAmp = Math.min(transition.travelDistance * 0.3, BOUNCE_AXIS_LIMIT);
  _transitionPos.x += THREE.MathUtils.clamp(transition.arrivalDir.x * bounce * bounceAmp, -BOUNCE_AXIS_LIMIT, BOUNCE_AXIS_LIMIT);
  _transitionPos.y += THREE.MathUtils.clamp(transition.arrivalDir.y * bounce * bounceAmp, -BOUNCE_AXIS_LIMIT, BOUNCE_AXIS_LIMIT);
  _transitionPos.z += THREE.MathUtils.clamp(transition.arrivalDir.z * bounce * bounceAmp, -BOUNCE_AXIS_LIMIT, BOUNCE_AXIS_LIMIT);

  camera.position.copy(_transitionPos);
  controls.target.lerpVectors(transition.fromTarget, transition.toTarget, curveT);
  camera.lookAt(controls.target);
  // Interpolate too, so the wiggle's amplitude doesn't jump the instant we arrive.
  currentZoomDistance = THREE.MathUtils.lerp(transition.fromZoomDistance, transition.view.zoomDistance, curveT);

  if (t >= 1) {
    applyFocusState(transition.view);
    transition = null;
  }
}

function scheduleAutoSwitch(delay = AUTO_SWITCH_MS) {
  clearTimeout(autoSwitchTimer);
  autoSwitchTimer = setTimeout(() => {
    focusOnObject(pickRandomObject(focusedObject), true);
    scheduleAutoSwitch();
  }, delay);
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

  // Each unique model is fetched once; repeat them round-robin to fill out 30.
  const templates = objects.filter(Boolean);
  const placedPositions = [];
  for (let i = 0; i < TOTAL_COUNT && templates.length; i++) {
    const instance = templates[i % templates.length].clone(true);
    const group = placeInCube(instance, placedPositions);
    scene.add(group);
    placedObjects.push(group);
  }

  focusOnObject(pickRandomObject(null), false);
  scheduleAutoSwitch();
  statusEl.style.display = 'none';
}

init();

window.addEventListener('resize', () => {
  camera.aspect = app.clientWidth / app.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(app.clientWidth, app.clientHeight);
  resizeBubbleCanvas();
});

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsedTime += dt;

  if (transition) {
    updateTransition();
  } else {
    controls.update();
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

  // Every object keeps spinning slowly around its own fixed random axis.
  for (const object of placedObjects) {
    object.rotateOnAxis(object.userData.spinAxis, object.userData.spinSpeed * dt);
  }

  // Nudge for this render only, then undo it — otherwise OrbitControls reads the
  // offset position back as the "real" camera on the next frame and it compounds
  // into runaway drift instead of a clean spring motion.
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
