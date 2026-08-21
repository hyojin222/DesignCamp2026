import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
export const SOURCE_DIR = path.join(ROOT, 'source');
const OUTPUT_DIR = path.join(ROOT, 'public', 'models');

const MESH_EXTS = new Set(['.obj', '.glb', '.gltf']);
const IMAGE_EXTS = new Set(['.tif', '.tiff', '.png', '.jpg', '.jpeg']);

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
function parseMeshName(base) {
  const m = base.match(/^([a-z0-9]+)_(.+)_(\d{3})_lod(\d+)$/i);
  if (m) {
    return {
      key: `${m[1]}_${m[2]}_${m[3]}`.toLowerCase(),
      name: m[2],
      lod: parseInt(m[4], 10),
    };
  }
  return { key: base.toLowerCase(), name: base, lod: 1 };
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
  const image = sharp(srcPath).resize(2048, 2048, { fit: 'inside', withoutEnlargement: true });
  if (role === 'normalMap') {
    const dest = `${destPathNoExt}.png`;
    await image.png().toFile(dest);
    return dest;
  }
  const dest = `${destPathNoExt}.jpg`;
  await image.jpeg({ quality: role === 'map' ? 88 : 82 }).toFile(dest);
  return dest;
}

export async function generateAssets() {
  await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

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
      const { key, name, lod } = parseMeshName(base);
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
    manifest.push({ id: slug, label: titleCase(base), type: 'glb', mesh: `/models/${slug}/model.glb` });
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
      textureUrls[role] = `/models/${slug}/${path.basename(destPath)}`;
    }

    manifest.push({
      id: slug,
      label: titleCase(group.name),
      type: 'obj',
      mesh: `/models/${slug}/model.obj`,
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
