import type { ActiveModule, CustomTab, ModuleMetricPoint, ModuleRun, StoreModule } from './types';
import { clearModuleCache } from './utils/moduleCache';

export interface ModuleDbSettings {
  mode: 'internal' | 'external';
  external: {
    host: string;
    port: number;
    username: string;
    database: string;
    has_password: boolean;
  };
}

export interface ModuleDbSettingsUpdate {
  mode: 'internal' | 'external';
  external?: {
    host: string;
    port: number;
    username: string;
    database: string;
    /** omitted = keep stored password, '' = clear it */
    password?: string;
  };
}

export interface ModuleDbTestRequest {
  host?: string;
  port?: number;
  username?: string;
  database?: string;
  password?: string;
}

const API_BASE_URL = '/api/v1';
let API_KEY = localStorage.getItem('zfs_access_token') || import.meta.env.VITE_API_KEY || '';

export const setApiKey = (key: string) => {
  API_KEY = key;
  localStorage.setItem('zfs_access_token', key);
};

export const clearApiKey = () => {
  API_KEY = '';
  localStorage.removeItem('zfs_access_token');
};

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  // Send token as both X-API-Key (for API keys) and Authorization Bearer (for session tokens)
  if (API_KEY) {
    headers['X-API-Key']     = API_KEY;
    headers['Authorization'] = `Bearer ${API_KEY}`;
  }

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const errorMsg = body.error || body.message || `Request failed with status ${response.status}`;
      console.error(`API Error [${path}]:`, errorMsg);
      throw new Error(errorMsg);
    }

    return response.json();
  } catch (err: any) {
    console.error(`Network Error [${path}]:`, err.message || err);
    throw err;
  }
}

export const formatBytes = (bytes: number | string, decimals = 2): string => {
  const n = Number(bytes);
  if (!n || isNaN(n)) return '0 B';
  const k = 1024;
  const dm = Math.max(0, decimals);
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(n) / Math.log(k));
  return `${parseFloat((n / Math.pow(k, i)).toFixed(dm))} ${sizes[Math.min(i, sizes.length - 1)]}`;
};

export const formatSpeed = (bytesPerSec: number, decimals = 2): string => {
  if (!bytesPerSec || isNaN(bytesPerSec) || bytesPerSec <= 0) return '0 B/s';
  const k = 1024;
  const dm = Math.max(0, decimals);
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s', 'PB/s', 'EB/s', 'ZB/s', 'YB/s'];
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
  return `${parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(dm))} ${sizes[Math.min(i, sizes.length - 1)]}`;
};

export const formatUnixTimestamp = (ts: string | number): string => {
  const n = typeof ts === 'string' ? parseInt(ts, 10) : ts;
  if (!n || isNaN(n)) return '—';
  return new Date(n * 1000).toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
};

export const api = {
  // ── Auth ───────────────────────────────────────────────────────────────────
  login: async (password: string): Promise<{ token: string; username: string; is_default_password: boolean }> => {
    const res = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || body.message || 'Login failed');
    }
    return res.json();
  },

  logout: async (): Promise<void> => {
    await request<void>('/auth/logout', { method: 'POST' }).catch(() => {});
    clearApiKey();
  },

  getMe: () => request<{ username: string; is_default_password: boolean }>('/auth/me'),

  // ── Settings ───────────────────────────────────────────────────────────────
  getApiKeys: () => request<{ keys: Array<{ id: number; name: string; prefix: string; created_at: string; last_used_at: string | null }> }>('/settings/api-keys'),

  createApiKey: (name: string, permissions = 'read') =>
    request<{ id: number; name: string; key: string; prefix: string }>('/settings/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name, permissions }),
    }),

  revokeApiKey: (id: number) =>
    request<{ message: string }>(`/settings/api-keys/${id}`, { method: 'DELETE' }),

  changePassword: (current_password: string, new_password: string, confirm_password: string) =>
    request<{ message: string }>('/settings/password', {
      method: 'POST',
      body: JSON.stringify({ current_password, new_password, confirm_password }),
    }),

  // ── Per-module database settings ───────────────────────────────────────────
  getModuleDatabase: (id: string) =>
    request<ModuleDbSettings>(`/modules/${encodeURIComponent(id)}/database`),

  updateModuleDatabase: (id: string, data: ModuleDbSettingsUpdate) =>
    request<ModuleDbSettings>(`/modules/${encodeURIComponent(id)}/database`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  testModuleDatabase: (id: string, data: ModuleDbTestRequest) =>
    request<{ ok: boolean; message: string }>(`/modules/${encodeURIComponent(id)}/database/test`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  // ── Pools ──────────────────────────────────────────────────────────────────
  getPools:            ()             => request<{ pools: any[] }>('/pools'),
  getPool:             (name: string) => request<any>(`/pools/${name}`),
  getPoolStatus:       (name: string) => request<{ name: string; status: string }>(`/pools/${name}/status`),
  getPoolHistory:      (name: string) => request<{ name: string; history: string[] }>(`/pools/${name}/history`),
  getPoolEvents:       (name: string) => request<{ name: string; events: any[] }>(`/pools/${name}/events`),
  getPoolIoStat:       (name: string) => request<{ iostat: any[][] }>(`/pools/${name}/iostat`),
  getPoolVdevs:        (name: string) => request<{ vdevs: any[] }>(`/pools/${name}/vdevs`),
  getImportablePools:  ()             => request<{ pools: any[] }>('/pools/importable'),
  getScrubStatus:      (name: string) => request<any>(`/pools/${name}/scrub-status`),
  startScrub:          (name: string) => request<any>(`/pools/${name}/scrub`, { method: 'POST' }),
  stopScrub:           (name: string) => request<any>(`/pools/${name}/scrub`, { method: 'DELETE' }),
  resilverPool:        (name: string) => request<any>(`/pools/${name}/resilver`, { method: 'POST' }),
  expandPool:          (name: string, disks: string | string[], vdevType?: string, force = false, targetVdev?: string) =>
    request<any>(`/pools/${name}/expand`, { method: 'POST', body: JSON.stringify({
      disks: Array.isArray(disks) ? disks : [disks],
      vdev_type: vdevType,
      target_vdev: targetVdev,
      force,
    }) }),
  replaceDisk: (poolName: string, oldDisk: string, newDisk: string, force = false) =>
    request<any>(`/pools/${poolName}/replace`, { method: 'POST', body: JSON.stringify({ old_disk: oldDisk, new_disk: newDisk, force }) }),
  removeDevice: (poolName: string, device: string) =>
    request<any>(`/pools/${poolName}/remove-device`, { method: 'POST', body: JSON.stringify({ device }) }),
  importPool: (name: string, dir?: string) =>
    request<any>(`/pools/${name}/import`, { method: 'POST', body: JSON.stringify({ dir }) }),
  importPoolById: (name: string, dir?: string) =>
    request<any>(`/pools/${name}/import`, { method: 'POST', body: JSON.stringify({ dir }) }),
  createPool: (name: string, vdevs: string[], options: string[] = []) =>
    request<any>('/pools', { method: 'POST', body: JSON.stringify({ name, vdevs, options }) }),
  destroyPool: (name: string) => request<any>(`/pools/${name}`, { method: 'DELETE' }),

  // ── Datasets ───────────────────────────────────────────────────────────────
  getDatasets: () => request<{ datasets: any[] }>('/datasets'),
  createDataset: (name: string, options: string[] = []) =>
    request<any>('/datasets', { method: 'POST', body: JSON.stringify({ name, options }) }),
  deleteDataset: (name: string, force = false, recursive = false) =>
    request<any>(`/datasets/${name}?force=${force}&recursive=${recursive}`, { method: 'DELETE' }),
  rewriteDataset: (datasetName: string) =>
    request<any>('/datasets/rewrite', { method: 'POST', body: JSON.stringify({ name: datasetName }) }),
  getRewriteStatus: (datasetName: string) =>
    request<{ in_progress: boolean, name: string }>(`/datasets/rewrite/status?name=${encodeURIComponent(datasetName)}`),
  getActiveRewrites: () =>
    request<{ active: Array<{ name: string; pool: string; total_bytes: number; processed_bytes: number; elapsed_secs: number }> }>('/datasets/rewrite/active'),
  getCompletedRewrites: () =>
    request<{ completed: Array<{
      name: string; pool: string; total_files: number; duration_secs: number;
      size_before_bytes: number; size_after_bytes: number;
      du_before_blocks: number; du_after_blocks: number;
    }> }>('/datasets/rewrite/completed'),

  mountDatasetPersistent: (name: string, mountpoint: string, encrypted = false) =>
    request<{ message: string; steps: string[] }>('/datasets/persistent-mount', {
      method: 'POST',
      body: JSON.stringify({ name, mountpoint, encrypted }),
    }),

  // ── Dataset Properties ─────────────────────────────────────────────────────
  getDatasetProperties: (name: string, props?: string) =>
    request<any>(`/properties/${name}${props ? `?prop=${encodeURIComponent(props)}` : ''}`),
  setDatasetProperty: (name: string, prop: string, value: string) =>
    request<any>(`/properties/${name}`, { method: 'PUT', body: JSON.stringify({ prop, value }) }),
  inheritDatasetProperty: (name: string, prop: string) =>
    request<any>(`/properties/${name}`, { method: 'DELETE', body: JSON.stringify({ prop }) }),

  // ── Snapshots ──────────────────────────────────────────────────────────────
  getSnapshots: () => request<{ snapshots: any[] }>('/snapshots'),
  createSnapshot: (fullName: string, recursive = false) =>
    request<any>('/snapshots', { method: 'POST', body: JSON.stringify({ name: fullName, recursive }) }),
  deleteSnapshot: (fullName: string) =>
    request<any>(`/snapshots/${fullName}`, { method: 'DELETE' }),
  rollbackSnapshot: (fullName: string, force = false) =>
    request<any>('/snapshots/rollback', { method: 'POST', body: JSON.stringify({ name: fullName, force }) }),

  // ── Volumes ────────────────────────────────────────────────────────────────
  getVolumes: () => request<{ volumes: any[] }>('/volumes'),

  // ── System ─────────────────────────────────────────────────────────────────
  getSystemStats: () => request<any>('/stats/system'),
  getDisks:       () => request<{ blockdevices: any[] }>('/system/disks'),
  getSmartData:   (device: string) => request<any>(`/system/smart/${encodeURIComponent(device)}`),
  getEnrichedDisks: () => request<{ disks: Array<{
    name: string; size_bytes: number; size_human: string;
    in_use: boolean; pool: string | null; partitions: boolean;
    model: string | null; serial: string | null; is_system: boolean;
  }> }>('/disks'),

  // ── Metrics ────────────────────────────────────────────────────────────────
  getMetricsHistory: (interval: string) =>
    request<{ metrics: any[]; interval: string; count: number }>(`/metrics/history?interval=${interval}`),

  getLiveMetrics: () =>
    request<{
      cpu_percent: number;
      arc_hit_ratio: number;
      total_read_mb: number;
      total_write_mb: number;
      read_bw_mb: number;
      write_bw_mb: number;
      read_iops: number;
      write_iops: number;
      total_read_gb_db: number;
      total_write_gb_db: number;
    }>('/metrics/live'),

  getFillPrediction: (window = 'auto') =>
    request<{
      predictions: Array<{
        pool: string;
        fill_date: string;
        color: string;
        rate_gb_day: string;
        window_used: string;
        window_key: string;
        alloc_gb: number;
        free_gb: number;
        points: number;
        fallback: boolean;
      }>;
      window_used: string | null;
      window_key: string | null;
    }>(`/metrics/fill-prediction?window=${encodeURIComponent(window)}`),

  getServerTime: () =>
    request<{ now: string; timezone: string }>('/time'),

  getHealth: () => request<any>('/health'),

  getLatestRelease: () =>
    request<{ tag_name: string }>('/health/latest-release'),

  refreshModuleStore: () =>
    request<{ modules: StoreModule[]; errors: Array<{ registry_url: string; error: string }> }>('/modules/store/refresh', {
      method: 'POST',
    }),

  // ── Pool Settings ──────────────────────────────────────────────────────────
  getPoolSettings: (name: string) =>
    request<{
      pool: string;
      pool_props: Array<{ name: string; value: string; source: string; scope: string }>;
      dataset_props: Array<{ name: string; value: string; source: string; scope: string }>;
    }>(`/pools/${encodeURIComponent(name)}/settings`),

  setPoolSetting: (name: string, scope: 'pool' | 'dataset', prop: string, value: string) =>
    request<{ message: string; pool: string; scope: string; prop: string; value: string }>(
      `/pools/${encodeURIComponent(name)}/settings`,
      { method: 'PUT', body: JSON.stringify({ scope, prop, value }) },
    ),

  getPoolFeatures: (name: string) =>
    request<{ pool: string; features: Array<{ name: string; property: string; value: string; enabled: boolean }> }>(
      `/pools/${encodeURIComponent(name)}/features`
    ),

  togglePoolFeature: (name: string, feature: string, enabled: boolean) =>
    request<{ message: string; pool: string; feature: string; enabled: boolean }>(
      `/pools/${encodeURIComponent(name)}/feature/${encodeURIComponent(feature)}`,
      { method: 'PUT', body: JSON.stringify({ enabled }) },
    ),

  getRaidzExpansionFeature: (name: string) =>
    request<{ pool: string; feature: string; value: string; enabled: boolean }>(
      `/pools/${encodeURIComponent(name)}/feature/raidz_expansion`
    ),

  enableRaidzExpansionFeature: (name: string) =>
    request<{ message: string; pool: string; feature: string; enabled: boolean }>(
      `/pools/${encodeURIComponent(name)}/feature/raidz_expansion/enable`,
      { method: 'POST' }
    ),

  // ── Pool Import Configs ────────────────────────────────────────────────────
  getImportConfigs: () =>
    request<{ configs: Array<{
      name: string; key_file?: string; encrypted: boolean;
      import_on_startup: boolean; enabled: boolean;
      bind_mounts: Array<{ source: string; target: string }>;
    }> }>('/pools/import-configs'),

  saveImportConfig: (config: {
    name: string; key_file?: string; encrypted: boolean;
    import_on_startup: boolean; enabled: boolean;
    bind_mounts: Array<{ source: string; target: string }>;
  }) =>
    request<{ message: string; config: any }>('/pools/import-configs', {
      method: 'POST',
      body: JSON.stringify(config),
    }),

  updateImportConfig: (name: string, config: {
    name: string; key_file?: string; encrypted: boolean;
    import_on_startup: boolean; enabled: boolean;
    bind_mounts: Array<{ source: string; target: string }>;
  }) =>
    request<{ message: string; config: any }>(`/pools/import-configs/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(config),
    }),

  deleteImportConfig: (name: string) =>
    request<{ message: string }>(`/pools/import-configs/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    }),

  runImportConfig: (name: string) =>
    request<{ message: string }>(`/pools/import-configs/${encodeURIComponent(name)}/run`, {
      method: 'POST',
    }),

  // ── Module system ──────────────────────────────────────────────────────────
  getModuleStore: () =>
    request<{ modules: StoreModule[]; errors: Array<{ registry_url: string; error: string }> }>('/modules/store'),

  getRegistries: () =>
    request<{ registries: Array<{ id: number; url: string; is_default: boolean }> }>('/modules/registries'),

  addRegistry: async (url: string) => {
    const res = await request<{ id: number; url: string }>('/modules/registries', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
    clearModuleCache();
    return res;
  },

  removeRegistry: async (id: number) => {
    const res = await request<{ ok: boolean }>(`/modules/registries/${id}`, { method: 'DELETE' });
    clearModuleCache();
    return res;
  },

  getModuleReleases: (repositoryUrl: string) =>
    request<{ releases: Array<{ tag_name: string; name: string; published_at: string; wasm_url: string }> }>(
      `/modules/releases?repository_url=${encodeURIComponent(repositoryUrl)}`
    ),

  installModule: async (registryUrl: string, id: string, version?: string, wasmUrl?: string) => {
    const res = await request<{ id: string; version: string }>('/modules/install', {
      method: 'POST',
      body: JSON.stringify({ registry_url: registryUrl, id, version, wasm_url: wasmUrl }),
    });
    clearModuleCache();
    return res;
  },

  getActiveModules: () => request<{ modules: ActiveModule[] }>('/modules/active'),

  uninstallModule: async (id: string) => {
    const res = await request<{ ok: boolean }>(`/modules/${encodeURIComponent(id)}`, { method: 'DELETE' });
    clearModuleCache();
    return res;
  },

  updateModuleConfig: (id: string, config: Record<string, unknown>, secrets: Record<string, string | null>) =>
    request<{ ok: boolean }>(`/modules/${encodeURIComponent(id)}/config`, {
      method: 'PUT',
      body: JSON.stringify({ config, secrets }),
    }),

  setModuleEnabled: (id: string, enabled: boolean) =>
    request<{ ok: boolean; enabled: boolean }>(
      `/modules/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`,
      { method: 'POST' },
    ),

  runModule: (id: string) =>
    request<{ run_id: number; success: boolean; message: string; metrics_written: number; error: string | null }>(
      `/modules/${encodeURIComponent(id)}/run`,
      { method: 'POST' },
    ),

  getModuleRuns: (id: string, limit = 50) =>
    request<{ runs: ModuleRun[] }>(`/modules/${encodeURIComponent(id)}/runs?limit=${limit}`),

  // ── Per-disk metrics ───────────────────────────────────────────────────────
  getPoolDiskMetrics: (poolName: string) =>
    request<{
      pool: string;
      disks: Array<{
        name: string;
        read_bw_mb: number;
        write_bw_mb: number;
        read_iops: number;
        write_iops: number;
        total_read_gb: number;
        total_write_gb: number;
      }>;
    }>(`/pools/${encodeURIComponent(poolName)}/disks`),

  // ── Custom Tabs ─────────────────────────────────────────────────────────────
  getCustomTabs: () => request<{ tabs: CustomTab[] }>('/custom-tabs'),
  getCustomTab: (slug: string) => request<CustomTab>(`/custom-tabs/${encodeURIComponent(slug)}`),
  createCustomTab: (name: string, icon = 'layout') =>
    request<{ id: number; slug: string; name: string; icon: string }>('/custom-tabs', {
      method: 'POST',
      body: JSON.stringify({ name, icon }),
    }),
  updateCustomTab: (slug: string, data: { name?: string; icon?: string; sort_order?: number }) =>
    request<{ ok: boolean }>(`/custom-tabs/${encodeURIComponent(slug)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteCustomTab: (slug: string) =>
    request<{ ok: boolean }>(`/custom-tabs/${encodeURIComponent(slug)}`, { method: 'DELETE' }),
  saveCustomTabLayout: (slug: string, layout: any[]) =>
    request<{ ok: boolean }>(`/custom-tabs/${encodeURIComponent(slug)}/layout`, {
      method: 'PUT',
      body: JSON.stringify(layout),
    }),

  // ── Module Metrics & Actions ──────────────────────────────────────────────
  getModuleMetrics: (id: string, metric?: string, interval = '1h') =>
    request<{ module_id: string; metrics: ModuleMetricPoint[] }>(
      `/modules/${encodeURIComponent(id)}/metrics?interval=${interval}${metric ? `&metric=${encodeURIComponent(metric)}` : ''}`
    ),
  pushModuleMetrics: (id: string, metrics: Array<{ metric_name: string; value: number }>) =>
    request<{ ok: boolean; written: number }>(`/modules/${encodeURIComponent(id)}/metrics`, {
      method: 'POST',
      body: JSON.stringify({ metrics }),
    }),
  switchModuleVersion: async (id: string, version: string, wasmUrl: string) => {
    const res = await request<{ ok: boolean; version: string }>(`/modules/${encodeURIComponent(id)}/switch-version`, {
      method: 'POST',
      body: JSON.stringify({ version, wasm_url: wasmUrl }),
    });
    clearModuleCache();
    return res;
  },
  executeModuleAction: (id: string, actionKey: string) =>
    request<{ run_id: number; action: string; success: boolean; message: string; metrics_written: number; error: string | null }>(
      `/modules/${encodeURIComponent(id)}/action/${encodeURIComponent(actionKey)}`,
      { method: 'POST' },
    ),
};
