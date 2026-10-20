// Masseopplasting: les EXIF, konverter HEIC, lag nettversjon og miniatyr, last opp, lagre rad.
import exifr from 'exifr';
import { supabase, BUCKET } from './supabase.js';

const FULL_PX = 2048;
const THUMB_PX = 480;
const CONCURRENCY = 3;

export function isImageFile(file) {
  const name = file.name.toLowerCase();
  if (/\.(mov|mp4|aae|json|xmp)$/.test(name)) return false;
  return file.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp)$/.test(name);
}

function isHeic(file) {
  return /image\/hei[cf]/.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

async function sha256(buffer) {
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function decode(file) {
  try {
    return await createImageBitmap(file);
  } catch (err) {
    if (!isHeic(file)) throw err;
    const { default: heic2any } = await import('heic2any');
    const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
    return createImageBitmap(Array.isArray(out) ? out[0] : out);
  }
}

function toJpeg(bitmap, maxPx, quality) {
  const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve({ blob: b, w, h }) : reject(new Error('Kunne ikke lage JPEG'))), 'image/jpeg', quality)
  );
}

/** Kvadratisk utsnitt fra midten, brukt til profilbilder. */
export async function squareJpeg(file, px = 256) {
  const bitmap = await decode(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, px, px);
  bitmap.close?.();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Kunne ikke lage bilde'))), 'image/jpeg', 0.85));
}

/** Les et bilde og gjør det klart for opplasting. */
export async function processFile(file) {
  const buffer = await file.arrayBuffer();
  const hash = await sha256(buffer);
  let meta = {};
  try {
    meta = (await exifr.parse(buffer, { gps: true, exif: true, tiff: true, xmp: false, icc: false })) ?? {};
  } catch {
    meta = {};
  }
  const taken = meta.DateTimeOriginal ?? meta.CreateDate ?? null;
  const lat = typeof meta.latitude === 'number' ? meta.latitude : null;
  const lon = typeof meta.longitude === 'number' ? meta.longitude : null;
  const bitmap = await decode(file);
  const full = await toJpeg(bitmap, FULL_PX, 0.85);
  const thumb = await toJpeg(bitmap, THUMB_PX, 0.78);
  bitmap.close?.();
  return {
    name: file.name,
    sha256: hash,
    takenAt: taken instanceof Date && !isNaN(taken) ? taken : null,
    lat,
    lon,
    full: full.blob,
    thumb: thumb.blob,
    thumbUrl: URL.createObjectURL(thumb.blob),
    width: full.w,
    height: full.h
  };
}

/** Finn hvilke hasher som allerede er lastet opp. */
export async function existingHashes(hashes) {
  const found = new Set();
  for (let i = 0; i < hashes.length; i += 100) {
    const chunk = hashes.slice(i, i + 100);
    const { data, error } = await supabase.from('photos').select('sha256').in('sha256', chunk);
    if (error) throw error;
    data.forEach((r) => found.add(r.sha256));
  }
  return found;
}

async function uploadOne(item, attempt = 1) {
  const year = item.takenAt ? item.takenAt.getFullYear() : 'ukjent';
  const path = `${year}/${item.sha256}.jpg`;
  const thumbPath = `thumbs/${item.sha256}.jpg`;
  try {
    const opts = { contentType: 'image/jpeg', upsert: true, cacheControl: '31536000' };
    const a = await supabase.storage.from(BUCKET).upload(path, item.full, opts);
    if (a.error) throw a.error;
    const b = await supabase.storage.from(BUCKET).upload(thumbPath, item.thumb, opts);
    if (b.error) throw b.error;
    const { data, error } = await supabase
      .from('photos')
      .upsert(
        {
          storage_path: path,
          thumb_path: thumbPath,
          sha256: item.sha256,
          original_name: item.name,
          taken_at: item.takenAt?.toISOString() ?? null,
          lat: item.lat,
          lon: item.lon,
          width: item.width,
          height: item.height
        },
        { onConflict: 'sha256' }
      )
      .select('id')
      .single();
    if (error) throw error;
    return data.id;
  } catch (err) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 800 * attempt));
      return uploadOne(item, attempt + 1);
    }
    throw err;
  }
}

/** Last opp mange elementer parallelt. onProgress(done, total, item, error). */
export async function uploadAll(items, onProgress) {
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < items.length) {
      const item = items[next++];
      try {
        item.id = await uploadOne(item);
        onProgress(++done, items.length, item, null);
      } catch (err) {
        item.error = err.message ?? String(err);
        onProgress(++done, items.length, item, err);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return items;
}
