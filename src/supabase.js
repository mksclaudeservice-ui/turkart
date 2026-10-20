import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const configured = Boolean(url && key);

export const supabase = configured
  ? createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    })
  : null;

export const BUCKET = 'photos';

/** Signed URLs for many storage paths at once, cached until shortly before expiry. */
const urlCache = new Map();
export async function signedUrls(paths) {
  const now = Date.now();
  const missing = [...new Set(paths)].filter((p) => {
    const hit = urlCache.get(p);
    return !hit || hit.expires < now + 60_000;
  });
  if (missing.length) {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(missing, 3600);
    if (error) throw error;
    for (const row of data) {
      if (row.signedUrl) urlCache.set(row.path, { url: row.signedUrl, expires: now + 3_500_000 });
    }
  }
  return Object.fromEntries(paths.map((p) => [p, urlCache.get(p)?.url ?? '']));
}
