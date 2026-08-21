import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const MODELS = [
  { label: 'KFC Zinger Burger', file: 'KFC, zinger burger photogrammetry.glb' },
  { label: 'Apple', file: 'Raw photoscan of an Apple .glb' },
];

const app = document.getElementById('app');
const statusEl = document.getElementById('status');
const selectEl = document.getElementById('model-select');

for (const m of MODELS) {
  const opt = document.createElement('option');
  opt.value = m.file;
  opt.textContent = m.label;
  selectEl.appendChild(opt);
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a1a);

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

const loader = new GLTFLoader();
let currentModel = null;

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
}

function loadModel(file) {
  statusEl.textContent = '불러오는 중...';
  statusEl.style.display = 'block';

  if (currentModel) {
    scene.remove(currentModel);
    currentModel = null;
  }

  loader.load(
    `/${encodeURIComponent(file).replace(/%2C/g, ',')}`,
    (gltf) => {
      currentModel = gltf.scene;
      scene.add(currentModel);
      frameModel(currentModel);
      statusEl.style.display = 'none';
    },
    undefined,
    (err) => {
      console.error(err);
      statusEl.textContent = '모델을 불러오지 못했습니다.';
    }
  );
}

selectEl.addEventListener('change', () => loadModel(selectEl.value));
loadModel(MODELS[0].file);

window.addEventListener('resize', () => {
  camera.aspect = app.clientWidth / app.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(app.clientWidth, app.clientHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
