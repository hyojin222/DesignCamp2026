import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const app = document.getElementById('app');
const statusEl = document.getElementById('status');
const selectEl = document.getElementById('model-select');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xFCFF1F);

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
app.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.rotateSpeed = 0.8;
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
let currentModel = null;

const clock = new THREE.Clock();
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

controls.addEventListener('start', () => {
  bobTarget = dipAmount;
  currentStiffness = SPRING_STIFFNESS_RISE;
  currentDamping = SPRING_DAMPING_RISE;
});
controls.addEventListener('end', () => {
  bobTarget = 0;
  currentStiffness = SPRING_STIFFNESS_FALL;
  currentDamping = SPRING_DAMPING_FALL;
});

function buildMaterial(textures) {
  const material = new THREE.MeshStandardMaterial({ color: 0xd8cdbe, roughness: 0.7, metalness: 0 });
  if (!textures) return material;
  if (textures.map) {
    const map = textureLoader.load(textures.map);
    map.colorSpace = THREE.SRGBColorSpace;
    material.map = map;
    material.color.set(0xffffff);
  }
  if (textures.normalMap) material.normalMap = textureLoader.load(textures.normalMap);
  if (textures.roughnessMap) {
    material.roughnessMap = textureLoader.load(textures.roughnessMap);
    material.roughness = 1;
  }
  if (textures.metalnessMap) {
    material.metalnessMap = textureLoader.load(textures.metalnessMap);
    material.metalness = 1;
  }
  if (textures.bumpMap) material.bumpMap = textureLoader.load(textures.bumpMap);
  return material;
}

function randomRange(min, max) {
  return min + Math.random() * (max - min);
}

function frameModel(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  object.position.sub(center);

  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const fitDistance = maxDim / (2 * Math.tan((Math.PI * camera.fov) / 360));

  // Zoom in close so the model's texture fills the frame, from a random angle each load.
  const zoomDistance = fitDistance * randomRange(0.42, 0.58);
  const theta = randomRange(0, Math.PI * 2);
  const phi = randomRange(Math.PI * 0.3, Math.PI * 0.7);

  camera.position.set(
    zoomDistance * Math.sin(phi) * Math.cos(theta),
    zoomDistance * Math.cos(phi),
    zoomDistance * Math.sin(phi) * Math.sin(theta)
  );
  camera.near = zoomDistance / 100;
  camera.far = fitDistance * 100;
  camera.updateProjectionMatrix();

  controls.target.set(0, 0, 0);
  controls.update();

  // How far the camera rises while dragging, scaled to how close it's sitting.
  dipAmount = zoomDistance * 0.08;
  bobOffset = 0;
  bobVelocity = 0;
  bobTarget = 0;
  currentStiffness = SPRING_STIFFNESS_RISE;
  currentDamping = SPRING_DAMPING_RISE;
}

function loadModel(model) {
  statusEl.textContent = '불러오는 중...';
  statusEl.style.display = 'block';

  if (currentModel) {
    scene.remove(currentModel);
    currentModel = null;
  }

  const onLoaded = (object) => {
    currentModel = object;
    scene.add(currentModel);
    frameModel(currentModel);
    statusEl.style.display = 'none';
  };
  const onError = (err) => {
    console.error(err);
    statusEl.textContent = '모델을 불러오지 못했습니다.';
  };

  if (model.type === 'obj') {
    objLoader.load(
      model.mesh,
      (object) => {
        const material = buildMaterial(model.textures);
        object.traverse((child) => {
          if (child.isMesh) child.material = material;
        });
        onLoaded(object);
      },
      undefined,
      onError
    );
  } else {
    gltfLoader.load(model.mesh, (gltf) => onLoaded(gltf.scene), undefined, onError);
  }
}

async function init() {
  const res = await fetch('/models/manifest.json');
  const models = await res.json();

  if (!models.length) {
    statusEl.textContent = 'source 폴더에서 모델을 찾지 못했습니다.';
    return;
  }

  selectEl.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    selectEl.appendChild(opt);
  }

  selectEl.addEventListener('change', () => {
    const model = models.find((m) => m.id === selectEl.value);
    loadModel(model);
  });
  loadModel(models[0]);
}

init();

window.addEventListener('resize', () => {
  camera.aspect = app.clientWidth / app.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(app.clientWidth, app.clientHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();

  // Spring the Y offset toward bobTarget: rises on drag start, eases back down
  // (with a little overshoot) on release.
  const dt = Math.min(clock.getDelta(), 0.05);
  const accel = (bobTarget - bobOffset) * currentStiffness - bobVelocity * currentDamping;
  bobVelocity += accel * dt;
  bobOffset += bobVelocity * dt;

  // Nudge for this render only, then undo it — otherwise OrbitControls reads the
  // offset position back as the "real" camera on the next frame and it compounds
  // into runaway drift instead of a clean spring motion.
  camera.position.y += bobOffset;
  renderer.render(scene, camera);
  camera.position.y -= bobOffset;
});
