import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
export const SOURCE_DIR = path.join(ROOT, 'source');
const OUTPUT_DIR = path.join(ROOT, 'public', 'models');
const LAYOUT_SOURCE_DIR = path.join(SOURCE_DIR, 'layout');
const LAYOUT_OUTPUT_DIR = path.join(ROOT, 'public', 'layout');
const ICON_SOURCE_DIR = path.join(SOURCE_DIR, 'icon');
const ICON_OUTPUT_DIR = path.join(ROOT, 'public', 'icon');
const SOUND_SOURCE_DIR = path.join(SOURCE_DIR, 'sound');
const SOUND_OUTPUT_DIR = path.join(ROOT, 'public', 'sound');

const MESH_EXTS = new Set(['.obj', '.glb', '.gltf']);
const IMAGE_EXTS = new Set(['.tif', '.tiff', '.png', '.jpg', '.jpeg']);
// Some sources (raw AI-mesh-generator exports in particular) ship totally
// undecimated meshes — multiple hundred MB for one object, millions of
// vertices — that will choke the browser (parsing + GPU upload + per-frame
// rendering of everything simultaneously on the wall) long before anything
// else in the pipeline notices. Skip rather than ship those; re-export at a
// sane poly count and it'll get picked back up automatically.
const MAX_MESH_BYTES = 25 * 1024 * 1024; // 25MB — raised from 20MB to admit toast's decimated "_reduced" export (~21MB)

const ROLE_ALIASES = {
  map: ['albedo', 'basecolor', 'diffuse', 'color'],
  normalMap: ['normal'],
  roughnessMap: ['roughness'],
  metalnessMap: ['metalness', 'metallic', 'metal'],
  bumpMap: ['height'],
};

function roleFromWord(word) {
  const w = word.toLowerCase();
  if (w === 'heightpn') return null; // packed/oversized displacement map, not a plain bump source
  for (const [role, aliases] of Object.entries(ROLE_ALIASES)) {
    if (aliases.includes(w)) return role;
  }
  return null;
}

function titleCase(words) {
  return words
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

// "food_strawberry_001_LOD1" -> { key: 'food_strawberry_001', name: 'strawberry', lod: 1 }
// Meshes that don't follow that convention (e.g. raw "Meshy_AI_..._texture"
// exports) fall back to the mesh's own folder name instead of its own ugly
// filename, since the folder is already how these get organized/named.
function parseMeshName(base, folderName) {
  const m = base.match(/^([a-z0-9]+)_(.+)_(\d{3})_lod(\d+)$/i);
  if (m) {
    return {
      key: `${m[1]}_${m[2]}_${m[3]}`.toLowerCase(),
      name: m[2],
      lod: parseInt(m[4], 10),
    };
  }
  return { key: folderName.toLowerCase(), name: folderName, lod: 1 };
}

// "food_strawberry_001_LOD1_albedo" -> { key: 'food_strawberry_001', lod: 1, role: 'map' }
function parseTextureName(base) {
  const m = base.match(/^([a-z0-9]+)_(.+)_(\d{3})_lod(\d+)_([a-z]+)$/i);
  if (!m) return null;
  const role = roleFromWord(m[5]);
  if (!role) return null;
  return { key: `${m[1]}_${m[2]}_${m[3]}`.toLowerCase(), lod: parseInt(m[4], 10), role, ext: null };
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function convertTexture(srcPath, destPathNoExt, role) {
  // Source textures can be unusually large (raw scans, uncompressed TIFFs);
  // `unlimited` skips sharp/libvips's memory-exhaustion guard that otherwise
  // refuses to even open them. Safe here since this only runs once at build
  // time, not per-frame in the browser, and resize() still streams rather
  // than materializing the full source in memory.
  const image = sharp(srcPath, { unlimited: true, limitInputPixels: false }).resize(2048, 2048, {
    fit: 'inside',
    withoutEnlargement: true,
  });
  if (role === 'normalMap') {
    const dest = `${destPathNoExt}.png`;
    await image.png().toFile(dest);
    return dest;
  }
  const dest = `${destPathNoExt}.jpg`;
  await image.jpeg({ quality: role === 'map' ? 88 : 82 }).toFile(dest);
  return dest;
}

// Mirrors every file matching extensions straight from srcDir into destDir,
// so editing a source asset (the goggle porthole shape, a button icon, the
// background music, ...) and reloading is all it takes for the app — which
// fetches these at runtime — to pick it up.
async function copyFilesDir(srcDir, destDir, extensions) {
  await fs.rm(destDir, { recursive: true, force: true });
  let entries = [];
  try {
    entries = await fs.readdir(srcDir, { withFileTypes: true });
  } catch {
    return;
  }
  const matches = entries.filter((e) => e.isFile() && extensions.has(path.extname(e.name).toLowerCase()));
  if (!matches.length) return;
  await fs.mkdir(destDir, { recursive: true });
  await Promise.all(matches.map((e) => fs.copyFile(path.join(srcDir, e.name), path.join(destDir, e.name))));
}

export async function generateAssets() {
  await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await copyFilesDir(LAYOUT_SOURCE_DIR, LAYOUT_OUTPUT_DIR, new Set(['.svg']));
  await copyFilesDir(ICON_SOURCE_DIR, ICON_OUTPUT_DIR, new Set(['.svg']));
  await copyFilesDir(SOUND_SOURCE_DIR, SOUND_OUTPUT_DIR, new Set(['.mp3', '.ogg', '.wav', '.m4a']));

  let allFiles = [];
  try {
    allFiles = await walk(SOURCE_DIR);
  } catch {
    await fs.writeFile(path.join(OUTPUT_DIR, 'manifest.json'), '[]');
    return [];
  }

  const glbFiles = [];
  const objGroups = new Map(); // dir::key -> { dir, name, meshes: [{lod, path}] }
  const texGroups = new Map(); // dir::key -> Map(lod -> {role: path})

  for (const file of allFiles) {
    const ext = path.extname(file).toLowerCase();
    const dir = path.dirname(file);
    const base = path.basename(file, ext);

    if (ext === '.glb' || ext === '.gltf') {
      glbFiles.push(file);
    } else if (ext === '.obj') {
      const { size } = await fs.stat(file);
      if (size > MAX_MESH_BYTES) {
        console.warn(`Skipping oversized mesh (${(size / 1024 / 1024).toFixed(0)}MB > ${MAX_MESH_BYTES / 1024 / 1024}MB): ${file}`);
        continue;
      }
      const { key, name, lod } = parseMeshName(base, path.basename(dir));
      const groupKey = `${dir}::${key}`;
      if (!objGroups.has(groupKey)) objGroups.set(groupKey, { dir, name, meshes: [] });
      objGroups.get(groupKey).meshes.push({ lod, path: file });
    } else if (IMAGE_EXTS.has(ext)) {
      if (/preview/i.test(base)) continue;
      const parsed = parseTextureName(base);
      if (!parsed) continue;
      const groupKey = `${dir}::${parsed.key}`;
      if (!texGroups.has(groupKey)) texGroups.set(groupKey, new Map());
      const byLod = texGroups.get(groupKey);
      if (!byLod.has(parsed.lod)) byLod.set(parsed.lod, {});
      byLod.get(parsed.lod)[parsed.role] = file;
    }
  }

  const manifest = [];
  const usedSlugs = new Set();
  const takeSlug = (base) => {
    let slug = slugify(base) || 'model';
    let i = 2;
    while (usedSlugs.has(slug)) slug = `${slugify(base)}-${i++}`;
    usedSlugs.add(slug);
    return slug;
  };

  for (const file of glbFiles) {
    const base = path.basename(file, path.extname(file));
    const slug = takeSlug(base);
    const destDir = path.join(OUTPUT_DIR, slug);
    await fs.mkdir(destDir, { recursive: true });
    await fs.copyFile(file, path.join(destDir, 'model.glb'));
    manifest.push({ id: slug, label: titleCase(base), type: 'glb', mesh: `models/${slug}/model.glb` });
  }

  for (const [groupKey, group] of objGroups) {
    const textures = texGroups.get(groupKey) ?? new Map();

    let bestLod = null;
    let bestScore = -1;
    for (const { lod } of group.meshes) {
      const score = Object.keys(textures.get(lod) ?? {}).length;
      if (score > bestScore || (score === bestScore && (bestLod === null || lod < bestLod))) {
        bestScore = score;
        bestLod = lod;
      }
    }
    const chosenMesh = group.meshes.find((m) => m.lod === bestLod) ?? group.meshes[0];
    const chosenTextures = textures.get(bestLod) ?? {};

    const slug = takeSlug(group.name);
    const destDir = path.join(OUTPUT_DIR, slug);
    await fs.mkdir(destDir, { recursive: true });
    await fs.copyFile(chosenMesh.path, path.join(destDir, 'model.obj'));

    const textureUrls = {};
    for (const [role, srcPath] of Object.entries(chosenTextures)) {
      const destPathNoExt = path.join(destDir, role);
      const destPath = await convertTexture(srcPath, destPathNoExt, role);
      textureUrls[role] = `models/${slug}/${path.basename(destPath)}`;
    }

    manifest.push({
      id: slug,
      label: titleCase(group.name),
      type: 'obj',
      mesh: `models/${slug}/model.obj`,
      textures: Object.keys(textureUrls).length ? textureUrls : undefined,
    });
  }

  manifest.sort((a, b) => a.label.localeCompare(b.label));
  await fs.writeFile(path.join(OUTPUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = await generateAssets();
  console.log(`Generated ${manifest.length} model(s):`, manifest.map((m) => m.label).join(', '));
}
