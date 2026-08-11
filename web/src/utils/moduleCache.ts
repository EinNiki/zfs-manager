import { api } from '../api';
import { StoreModule, ActiveModule } from '../types';

const STORE_CACHE_KEY = 'zfs_module_store_cache';
const ACTIVE_CACHE_KEY = 'zfs_active_modules_cache';
const LATEST_RELEASE_CACHE_KEY = 'zfs_latest_release_cache';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const STORE_TTL_FOR_UPDATE_CHECK_MS = 5 * 60 * 1000; // 5 minutes — update badges don't need to be real-time
const LATEST_RELEASE_TTL_MS = 30 * 60 * 1000; // 30 minutes — sidebar version check

interface CacheEntry<T> {
  timestamp: number;
  data: T;
}

export function isUpdateAvailable(currentVersion?: string, latestVersion?: string): boolean {
  if (!currentVersion || !latestVersion) return false;
  const currentClean = currentVersion.trim().replace(/^v+/i, '');
  const latestClean = latestVersion.trim().replace(/^v+/i, '');

  if (!currentClean || !latestClean || currentClean === latestClean) return false;

  const cParts = currentClean.split('.').map(part => parseInt(part, 10) || 0);
  const lParts = latestClean.split('.').map(part => parseInt(part, 10) || 0);

  for (let i = 0; i < Math.max(cParts.length, lParts.length); i++) {
    const c = cParts[i] || 0;
    const l = lParts[i] || 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}

export async function getModuleStoreCached(forceRefresh = false): Promise<{ modules: StoreModule[]; errors: Array<{ registry_url: string; error: string }> }> {
  return getModuleStoreCachedWithTTL(forceRefresh, CACHE_TTL_MS);
}

/// Used by Active Modules page — shorter TTL so update-available badges
/// show up quickly after a new release is published.
export async function getModuleStoreForUpdateCheck(forceRefresh = false): Promise<{ modules: StoreModule[]; errors: Array<{ registry_url: string; error: string }> }> {
  return getModuleStoreCachedWithTTL(forceRefresh, STORE_TTL_FOR_UPDATE_CHECK_MS);
}

async function getModuleStoreCachedWithTTL(forceRefresh: boolean, ttlMs: number): Promise<{ modules: StoreModule[]; errors: Array<{ registry_url: string; error: string }> }> {
  if (!forceRefresh) {
    try {
      const raw = localStorage.getItem(STORE_CACHE_KEY);
      if (raw) {
        const entry: CacheEntry<{ modules: StoreModule[]; errors: Array<{ registry_url: string; error: string }> }> = JSON.parse(raw);
        if (Date.now() - entry.timestamp < ttlMs) {
          return entry.data;
        }
      }
    } catch {
      // Ignore cache parse error
    }
  }

  // When forceRefresh is true, the caller should use api.refreshModuleStore()
  // directly (which invalidates the backend GitHub cache). This function is
  // only used for the non-force path, so we always call the regular endpoint.
  const freshData = await api.getModuleStore();
  try {
    localStorage.setItem(STORE_CACHE_KEY, JSON.stringify({
      timestamp: Date.now(),
      data: freshData,
    }));
  } catch (err) {
    console.warn('Failed to cache module store data:', err);
  }

  return freshData;
}

/// Updates the localStorage cache with fresh data from the refresh endpoint.
/// Called after api.refreshModuleStore() returns.
export function updateModuleStoreCache(data: { modules: StoreModule[]; errors: Array<{ registry_url: string; error: string }> }) {
  try {
    localStorage.setItem(STORE_CACHE_KEY, JSON.stringify({
      timestamp: Date.now(),
      data,
    }));
  } catch (err) {
    console.warn('Failed to cache module store data:', err);
  }
}

export async function getActiveModulesCached(forceRefresh = false): Promise<{ modules: ActiveModule[] }> {
  if (!forceRefresh) {
    try {
      const raw = localStorage.getItem(ACTIVE_CACHE_KEY);
      if (raw) {
        const entry: CacheEntry<{ modules: ActiveModule[] }> = JSON.parse(raw);
        if (Date.now() - entry.timestamp < CACHE_TTL_MS) {
          return entry.data;
        }
      }
    } catch {
      // Ignore cache parse error
    }
  }

  const freshData = await api.getActiveModules();
  try {
    localStorage.setItem(ACTIVE_CACHE_KEY, JSON.stringify({
      timestamp: Date.now(),
      data: freshData,
    }));
  } catch (err) {
    console.warn('Failed to cache active modules data:', err);
  }

  return freshData;
}

export function clearModuleCache(): void {
  localStorage.removeItem(STORE_CACHE_KEY);
  localStorage.removeItem(ACTIVE_CACHE_KEY);
  localStorage.removeItem(LATEST_RELEASE_CACHE_KEY);
}

/// Cached version of api.getLatestRelease() — avoids hitting the backend
/// on every page load. The backend endpoint is cache-only (no GitHub API
/// call), but we still avoid unnecessary network round-trips.
export async function getLatestReleaseCached(): Promise<{ tag_name: string }> {
  try {
    const raw = localStorage.getItem(LATEST_RELEASE_CACHE_KEY);
    if (raw) {
      const entry: CacheEntry<{ tag_name: string }> = JSON.parse(raw);
      if (Date.now() - entry.timestamp < LATEST_RELEASE_TTL_MS) {
        return entry.data;
      }
    }
  } catch {
    // Ignore cache parse error
  }
  const fresh = await api.getLatestRelease();
  try {
    localStorage.setItem(LATEST_RELEASE_CACHE_KEY, JSON.stringify({
      timestamp: Date.now(),
      data: fresh,
    }));
  } catch {
    // Ignore storage errors
  }
  return fresh;
}
