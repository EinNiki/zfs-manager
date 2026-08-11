import React, { useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Package, Plus, Trash2, Download, CheckCircle, AlertTriangle, RefreshCw, ArrowUpCircle, Search, Info, FileSearch, Loader2 } from 'lucide-react';
import { api } from '../api';
import { StoreModule } from '../types';
import PageTransition from '../components/PageTransition';
import Modal from '../components/Modal';
import { useNotifications } from '../context/NotificationContext';
import { getModuleStoreCached, isUpdateAvailable, updateModuleStoreCache } from '../utils/moduleCache';

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-surface)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-lg)', padding: 18,
  display: 'flex', flexDirection: 'column', gap: 10,
};

function formatVersion(version?: string): string {
  if (!version) return '';
  const trimmed = version.trim();
  if (!trimmed) return '';
  const clean = trimmed.replace(/^v+/i, '');
  return `v${clean}`;
}

function formatRegistryError(error: string): string {
  if (error.includes('invalid registry index') || error.includes('expected value') || error.includes('syntax error')) {
    return 'Ungültige Registry-URL: Keine gültige index.json Datei erkannt';
  }
  return error;
}

const SELECTION_STORAGE_KEY = 'zfs_registry_selections';

function getStoredRegistrySelections(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SELECTION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function setStoredRegistrySelections(selections: Record<string, string>) {
  try {
    localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(selections));
  } catch (err) {
    console.warn('Failed to save registry selections:', err);
  }
}

export default function ModuleStore() {
  const { notify } = useNotifications();
  const [modules, setModules] = useState<StoreModule[]>([]);
  const [errors, setErrors] = useState<Array<{ registry_url: string; error: string }>>([]);
  const [registries, setRegistries] = useState<Array<{ id: number; url: string; is_default: boolean }>>([]);
  const [newRegistryUrl, setNewRegistryUrl] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [updatingAll, setUpdatingAll] = useState(false);

  // Version Picker Modal State
  const [selectedModuleForVersionModal, setSelectedModuleForVersionModal] = useState<StoreModule | null>(null);
  const [availableReleases, setAvailableReleases] = useState<Array<{ tag_name: string; name: string; published_at: string; wasm_url: string }>>([]);
  const [loadingReleases, setLoadingReleases] = useState(false);
  const [selectedReleaseTag, setSelectedReleaseTag] = useState('');
  const [selectedWasmUrl, setSelectedWasmUrl] = useState('');

  // Duplicate Modules Modal State & Selections
  interface DuplicateGroup {
    id: string;
    name: string;
    instances: StoreModule[];
  }
  const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([]);
  const [selectedRegistryForMod, setSelectedRegistryForMod] = useState<Record<string, string>>({});
  const [rawStoreModules, setRawStoreModules] = useState<StoreModule[]>([]);
  const [showDuplicateModal, setShowDuplicateModal] = useState(false);
  const [pendingAddRegistryUrl, setPendingAddRegistryUrl] = useState<string | null>(null);

  // Registry Discovery State
  const [discovering, setDiscovering] = useState(false);
  const [discoveryResults, setDiscoveryResults] = useState<Array<{ url: string; modules: any[] }> | null>(null);
  const [discoveryInput, setDiscoveryInput] = useState('');
  const [showDiscoveryModal, setShowDiscoveryModal] = useState(false);
  const [selectedDiscoveryUrl, setSelectedDiscoveryUrl] = useState('');
  const [selectedDiscoveryModules, setSelectedDiscoveryModules] = useState<any[]>([]);
  const [addingRegistry, setAddingRegistry] = useState(false);

  const filterAndSetModules = (rawMods: StoreModule[], selections: Record<string, string>) => {
    // Validate selections against currently available rawMods per module ID
    const validRegistriesByMod = new Map<string, Set<string>>();
    rawMods.forEach(m => {
      if (!validRegistriesByMod.has(m.id)) validRegistriesByMod.set(m.id, new Set());
      validRegistriesByMod.get(m.id)!.add(m.registry_url);
    });

    const cleanedSelections: Record<string, string> = { ...selections };
    let changed = false;
    Object.keys(cleanedSelections).forEach(id => {
      const valid = validRegistriesByMod.get(id);
      if (!valid || !valid.has(cleanedSelections[id])) {
        delete cleanedSelections[id];
        changed = true;
      }
    });

    if (changed) {
      setStoredRegistrySelections(cleanedSelections);
      setSelectedRegistryForMod(cleanedSelections);
    }

    const seen = new Set<string>();
    const result: StoreModule[] = [];

    rawMods.forEach(mod => {
      const activeSel = cleanedSelections[mod.id];
      if (activeSel) {
        if (mod.registry_url === activeSel && !seen.has(mod.id)) {
          seen.add(mod.id);
          result.push(mod);
        }
      } else if (!seen.has(mod.id)) {
        seen.add(mod.id);
        result.push(mod);
      }
    });

    setModules(result);
  };

  const initialMount = React.useRef(true);

  const reload = async (isNewAdd = false, forceRefresh = false) => {
    const isInitial = initialMount.current;
    if (isInitial) initialMount.current = false;
    const isManualRefresh = forceRefresh && !isNewAdd && !isInitial;
    if (isManualRefresh) setRefreshing(true);
    setLoading(true);
    try {
      let store;
      if (forceRefresh) {
        // Force refresh: call the backend refresh endpoint which invalidates
        // the GitHub cache, re-fetches all registries + release info, and
        // returns the fresh store listing.
        store = await api.refreshModuleStore();
        updateModuleStoreCache(store);
      } else {
        store = await getModuleStoreCached(false);
      }
      const regs = await api.getRegistries();
      setRegistries(regs.registries);
      setErrors(store.errors);
      setRawStoreModules(store.modules);

      if (isManualRefresh) {
        const modCount = store.modules.length;
        const errCount = store.errors.length;
        notify({
          type: errCount > 0 ? 'error' : 'success',
          title: 'Module Store',
          message: errCount > 0
            ? `Aktualisiert: ${modCount} Module, ${errCount} Registry-Fehler`
            : `Aktualisiert: ${modCount} Module geladen`,
        });
      }

      // Detect duplicate modules across registries
      const grouped = new Map<string, StoreModule[]>();
      store.modules.forEach(mod => {
        const list = grouped.get(mod.id) || [];
        grouped.set(mod.id, [...list, mod]);
      });

      const dups: DuplicateGroup[] = [];
      const storedSelections = getStoredRegistrySelections();
      const currentSelections: Record<string, string> = { ...storedSelections };
      let hasUnresolvedDups = false;

      grouped.forEach((list, id) => {
        if (list.length > 1) {
          dups.push({
            id,
            name: list[0].name,
            instances: list,
          });

          // Check if choice exists in localStorage and is still valid
          if (!currentSelections[id] || !list.some(m => m.registry_url === currentSelections[id])) {
            currentSelections[id] = list[0].registry_url;
            hasUnresolvedDups = true;
          }
        }
      });

      filterAndSetModules(store.modules, currentSelections);
      setSelectedRegistryForMod(currentSelections);
      setDuplicateGroups(dups);

      // Open modal only if explicitly requested (e.g. newly added registry) OR there are unresolved duplicates
      if (dups.length > 0 && (isNewAdd || hasUnresolvedDups)) {
        setShowDuplicateModal(true);
      } else {
        setShowDuplicateModal(false);
      }
    } catch (err) {
      notify({ type: 'error', title: 'Module Store', message: `Failed to load: ${(err as Error).message}` });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { reload(false, true); }, []);

  const openInstallModal = async (mod: StoreModule) => {
    setSelectedModuleForVersionModal(mod);
    setSelectedReleaseTag('');
    setSelectedWasmUrl('');
    setAvailableReleases([]);

    if (mod.repository_url) {
      setLoadingReleases(true);
      try {
        const res = await api.getModuleReleases(mod.repository_url);
        setAvailableReleases(res.releases);
        if (res.releases.length > 0) {
          setSelectedReleaseTag(res.releases[0].tag_name);
          setSelectedWasmUrl(res.releases[0].wasm_url);
        }
      } catch (err) {
        console.warn('Failed to fetch releases:', err);
      } finally {
        setLoadingReleases(false);
      }
    }
  };

  const confirmInstallWithVersion = async () => {
    if (!selectedModuleForVersionModal) return;
    const mod = selectedModuleForVersionModal;
    setBusyId(mod.id);
    try {
      if (mod.installed) {
        await api.switchModuleVersion(
          mod.id,
          selectedReleaseTag || mod.version,
          selectedWasmUrl || undefined
        );
        notify({
          type: 'success',
          title: 'Module Store',
          message: `Switched "${mod.name}" to version ${selectedReleaseTag}`,
        });
      } else {
        await api.installModule(
          mod.registry_url,
          mod.id,
          selectedReleaseTag || undefined,
          selectedWasmUrl || undefined
        );
        notify({
          type: 'success',
          title: 'Module Store',
          message: `Module "${mod.name}" ${selectedReleaseTag ? `(${selectedReleaseTag}) ` : ''}installed`,
        });
      }
      setSelectedModuleForVersionModal(null);
      await reload();
    } catch (err) {
      notify({ type: 'error', title: 'Module Store', message: `Operation failed: ${(err as Error).message}` });
    } finally {
      setBusyId(null);
    }
  };

  const updateAll = async () => {
    const toUpdate = modules.filter(m => m.installed && isUpdateAvailable(m.installed_version, m.version));
    if (toUpdate.length === 0) return;
    setUpdatingAll(true);
    let successCount = 0;
    let failCount = 0;
    for (const mod of toUpdate) {
      try {
        // Fetch releases to get the wasm_url of the latest version
        const res = await api.getModuleReleases(mod.repository_url);
        const latest = res.releases.find(r => r.tag_name === mod.version) ?? res.releases[0];
        if (!latest) { failCount++; continue; }
        await api.switchModuleVersion(mod.id, latest.tag_name, latest.wasm_url);
        successCount++;
      } catch {
        failCount++;
      }
    }
    setUpdatingAll(false);
    if (successCount > 0) {
      notify({
        type: failCount > 0 ? 'error' : 'success',
        title: 'Module Store',
        message: failCount > 0
          ? `${successCount} updated, ${failCount} failed`
          : `${successCount} module${successCount === 1 ? '' : 's'} updated`,
      });
    } else {
      notify({ type: 'error', title: 'Module Store', message: 'All updates failed' });
    }
    await reload();
  };

  const confirmDuplicateSelections = async () => {
    setStoredRegistrySelections(selectedRegistryForMod);

    if (pendingAddRegistryUrl) {
      const urlToAdd = pendingAddRegistryUrl;
      setPendingAddRegistryUrl(null);
      setShowDuplicateModal(false);
      try {
        await api.addRegistry(urlToAdd);
        setNewRegistryUrl('');
        notify({ type: 'success', title: 'Module Store', message: 'Registry hinzugefügt' });
        await reload(false, true);
      } catch (err) {
        notify({ type: 'error', title: 'Module Store', message: `Adding registry failed: ${(err as Error).message}` });
      }
    } else {
      filterAndSetModules(rawStoreModules, selectedRegistryForMod);
      setShowDuplicateModal(false);
    }
  };

  const cancelDuplicateSelections = () => {
    if (pendingAddRegistryUrl) {
      notify({ type: 'info', title: 'Module Store', message: 'Hinzufügen der Registry abgebrochen.' });
      setPendingAddRegistryUrl(null);
    }
    setShowDuplicateModal(false);
  };

  const addRegistry = async () => {
    const url = newRegistryUrl.trim();
    if (!url) return;

    if (registries.some(r => r.url === url)) {
      notify({ type: 'warning', title: 'Module Store', message: 'This registry URL is already in the list.' });
      return;
    }

    // Always use the discovery endpoint — it handles both direct .json URLs
    // and repo URLs, and returns the module data so we don't need to make
    // cross-origin requests from the browser (which would hit CORS).
    setDiscovering(true);
    setDiscoveryInput(url);
    try {
      const res = await api.discoverRegistry(url);
      if (res.found.length === 0) {
        notify({
          type: 'error',
          title: 'Module Store',
          message: `No valid registry index found. Checked ${res.candidates_checked} candidate locations.`,
        });
      } else if (res.found.length === 1) {
        // Single match — show confirmation modal
        setDiscoveryResults(res.found);
        setSelectedDiscoveryUrl(res.found[0].url);
        setSelectedDiscoveryModules(res.found[0].modules);
        setShowDiscoveryModal(true);
      } else {
        // Multiple matches — let user pick
        setDiscoveryResults(res.found);
        setSelectedDiscoveryUrl(res.found[0].url);
        setSelectedDiscoveryModules(res.found[0].modules);
        setShowDiscoveryModal(true);
      }
    } catch (err) {
      notify({ type: 'error', title: 'Module Store', message: `Discovery failed: ${(err as Error).message}` });
    } finally {
      setDiscovering(false);
    }
  };

  /// Adds a registry URL after discovery confirmation.
  /// Uses the module data from the discovery response for duplicate checking —
  /// no cross-origin fetch from the browser.
  const addRegistryDirect = async (url: string, modules: any[]) => {
    setAddingRegistry(true);
    setLoading(true);
    try {
      const candidateModules: StoreModule[] = modules.map((m: any) => ({
        ...m,
        registry_url: url,
        installed: false,
      }));

      // Combine existing raw modules with candidate modules to check for duplicate IDs
      const combined = [...rawStoreModules, ...candidateModules];
      const grouped = new Map<string, StoreModule[]>();
      combined.forEach(mod => {
        const list = grouped.get(mod.id) || [];
        grouped.set(mod.id, [...list, mod]);
      });

      const dups: DuplicateGroup[] = [];
      const storedSelections = getStoredRegistrySelections();
      const currentSelections: Record<string, string> = { ...storedSelections };

      grouped.forEach((list, id) => {
        if (list.length > 1) {
          dups.push({
            id,
            name: list[0].name,
            instances: list,
          });

          if (!currentSelections[id] || !list.some(m => m.registry_url === currentSelections[id])) {
            currentSelections[id] = list[0].registry_url;
          }
        }
      });

      if (dups.length > 0) {
        // Duplicates found! Prompt user in modal BEFORE saving URL to DB
        setPendingAddRegistryUrl(url);
        setDuplicateGroups(dups);
        setSelectedRegistryForMod(currentSelections);
        setShowDuplicateModal(true);
      } else {
        // No duplicates! Directly add registry URL to backend DB
        await api.addRegistry(url);
        setNewRegistryUrl('');
        notify({ type: 'success', title: 'Module Store', message: 'Registry added' });
        await reload(false, true);
      }
    } catch (err) {
      notify({ type: 'error', title: 'Module Store', message: `Adding registry failed: ${(err as Error).message}` });
    } finally {
      setLoading(false);
      setAddingRegistry(false);
    }
  };

  const confirmDiscoverySelection = async () => {
    if (!selectedDiscoveryUrl) return;
    const modules = selectedDiscoveryModules;
    const url = selectedDiscoveryUrl;
    setShowDiscoveryModal(false);
    setDiscoveryResults(null);
    await addRegistryDirect(url, modules);
  };

  const cancelDiscovery = () => {
    setShowDiscoveryModal(false);
    setDiscoveryResults(null);
    setSelectedDiscoveryUrl('');
    setSelectedDiscoveryModules([]);
    notify({ type: 'info', title: 'Module Store', message: 'Registry discovery cancelled.' });
  };

  const removeRegistry = async (id: number) => {
    try {
      await api.removeRegistry(id);
      notify({ type: 'success', title: 'Module Store', message: 'Registry removed' });
      await reload();
    } catch (err) {
      notify({ type: 'error', title: 'Module Store', message: `Removing registry failed: ${(err as Error).message}` });
    }
  };

  return (
    <PageTransition>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontFamily: 'var(--font-ui)', fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.01em', margin: 0 }}>
              Module Store
            </h1>
            <p style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)', marginTop: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              Community modules · sandboxed
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', minWidth: 180 }}>
              <Search size={13} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
              <input
                type="text"
                className="input"
                placeholder="Filter…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                style={{ paddingLeft: 34, width: '100%' }}
              />
            </div>
            {duplicateGroups.length > 0 && (
              <button
                className="btn"
                style={{ borderColor: 'rgba(245, 158, 11, 0.4)', background: 'rgba(245, 158, 11, 0.1)', color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: 6 }}
                onClick={() => setShowDuplicateModal(true)}
                title="Resolve duplicate module sources"
              >
                <AlertTriangle size={14} /> Duplicates ({duplicateGroups.length})
              </button>
            )}
            <button className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: 6 }} onClick={() => reload(false, true)} disabled={refreshing} title="Cache leeren & Registries neu abfragen">
              <RefreshCw size={14} className={refreshing ? 'spin' : ''} /> {refreshing ? 'Aktualisiere…' : 'Refresh'}
            </button>
            {modules.filter(m => m.installed && isUpdateAvailable(m.installed_version, m.version)).length > 1 && (
              <button
                className="btn"
                style={{ display: 'flex', alignItems: 'center', gap: 6, borderColor: 'rgba(245, 158, 11, 0.4)', background: 'rgba(245, 158, 11, 0.1)', color: 'var(--warning)', opacity: updatingAll ? 0.6 : 1 }}
                onClick={updateAll}
                disabled={updatingAll}
                title="Update all modules with available updates"
              >
                {updatingAll ? <Loader2 size={14} className="spin" /> : <ArrowUpCircle size={14} />}
                {updatingAll ? 'Updating…' : `Update All (${modules.filter(m => m.installed && isUpdateAvailable(m.installed_version, m.version)).length})`}
              </button>
            )}
          </div>
        </div>

        {errors.map(e => (
          <div key={e.registry_url} style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
            background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.3)',
            borderRadius: 'var(--radius)', color: 'var(--warning)', fontSize: 12, fontFamily: 'var(--font-ui)',
          }}>
            <AlertTriangle size={14} style={{ flexShrink: 0 }} />
            <span>{e.registry_url}: {formatRegistryError(e.error)}</span>
          </div>
        ))}

        <div style={{
          display: 'grid', gap: 16,
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
        }}>
          {modules.filter(mod => 
            mod.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
            mod.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
            (mod.author && mod.author.toLowerCase().includes(searchQuery.toLowerCase())) ||
            mod.description.toLowerCase().includes(searchQuery.toLowerCase())
          ).map(mod => {
            const regIdx = registries.findIndex(r => r.url === mod.registry_url);
            const regNumber = regIdx !== -1 ? regIdx + 1 : null;
            const hasUpdate = mod.installed && isUpdateAvailable(mod.installed_version, mod.version);

            return (
              <div key={`${mod.registry_url}:${mod.id}`} style={cardStyle}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, overflow: 'hidden' }}>
                    <div style={{
                      width: 36, height: 36, background: 'var(--accent-dim)',
                      border: '1px solid var(--accent-mid)', borderRadius: 'var(--radius)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    }}>
                      <Package size={18} color="var(--accent)" />
                    </div>
                    <div style={{ overflow: 'hidden' }}>
                      <div style={{ fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                        {mod.name}
                      </div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>
                        {mod.author ? mod.author : 'Community Module'}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {hasUpdate && (
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        background: 'rgba(245, 158, 11, 0.15)', color: 'var(--warning, #f59e0b)',
                        border: '1px solid rgba(245, 158, 11, 0.35)', borderRadius: 4,
                        padding: '2px 7px', fontSize: 10, fontWeight: 700,
                        fontFamily: 'var(--font-ui)', textTransform: 'uppercase', letterSpacing: '0.04em'
                      }}>
                        <ArrowUpCircle size={11} /> Update Available
                      </span>
                    )}
                    {regNumber !== null && (
                      <div
                        title={`Registry #${regNumber}: ${mod.registry_url}`}
                        style={{
                          width: 24, height: 24, borderRadius: '50%',
                          background: 'var(--accent-dim)', border: '1px solid var(--accent-mid)',
                          color: 'var(--accent)', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          flexShrink: 0, cursor: 'help'
                        }}
                      >
                        {regNumber}
                      </div>
                    )}
                  </div>
                </div>

                <p style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5, flex: 1 }}>
                  {mod.description}
                </p>
                {mod.installed ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--success, #22c55e)', fontSize: 12, fontFamily: 'var(--font-ui)', fontWeight: 600 }}>
                      <CheckCircle size={14} />
                      <span>Installed {mod.installed_version ? `(${formatVersion(mod.installed_version)})` : ''}</span>
                    </div>
                    <button
                      className="btn btn-secondary"
                      style={{ opacity: busyId === mod.id ? 0.6 : 1, padding: '0 10px', height: 28, fontSize: 11, display: 'flex', alignItems: 'center', gap: 6, color: hasUpdate ? 'var(--warning)' : 'var(--text-secondary)', borderColor: hasUpdate ? 'rgba(245, 158, 11, 0.4)' : 'var(--border)' }}
                      disabled={busyId === mod.id}
                      onClick={() => openInstallModal(mod)}
                    >
                      <RefreshCw size={12} /> {hasUpdate ? 'Update / Switch' : 'Switch Version'}
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn btn-primary"
                    style={{ opacity: busyId === mod.id ? 0.6 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                    disabled={busyId === mod.id}
                    onClick={() => openInstallModal(mod)}
                  >
                    <Download size={14} /> {busyId === mod.id ? 'Installing…' : 'Install'}
                  </button>
                )}
              </div>
            );
          })}
          {!loading && modules.length === 0 && (
            <div style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-ui)', fontSize: 13 }}>
              No modules available. Check your registries below.
            </div>
          )}
        </div>

        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <h3 style={{ fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                Registries
              </h3>
              <p style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-muted)', margin: '2px 0 0' }}>
                Quellen, aus denen Community-Module geladen werden
              </p>
            </div>
            <span className="badge">{registries.length}</span>
          </div>
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {registries.map((reg, idx) => (
              <div key={reg.id} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
                background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
              }}>
                <span style={{
                  width: 22, height: 22, borderRadius: '50%', background: 'var(--accent-dim)',
                  border: '1px solid var(--accent-mid)', color: 'var(--accent)',
                  fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
                }}>
                  {idx + 1}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {reg.url}
                </span>
                {reg.is_default ? (
                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    default
                  </span>
                ) : (
                  <button
                    onClick={() => removeRegistry(reg.id)}
                    title="Remove registry"
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex' }}
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="input"
                style={{ flex: 1 }}
                placeholder="https://github.com/example/repo or https://example.com/registry/index.json"
                value={newRegistryUrl}
                onChange={e => setNewRegistryUrl(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addRegistry()}
              />
              <button
                className="btn btn-primary"
                style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, opacity: discovering || addingRegistry ? 0.6 : 1 }}
                onClick={addRegistry}
                disabled={discovering || addingRegistry}
              >
                {discovering ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
                {discovering ? 'Searching…' : addingRegistry ? 'Adding…' : 'Add registry'}
              </button>
            </div>
            <p style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' }}>
              You can enter a direct <code style={{ fontFamily: 'var(--font-mono)' }}>index.json</code> URL or just a GitHub repo URL — the dashboard will automatically search for the registry index file.
            </p>
          </div>
        </div>

        {/* Registry Discovery Modal */}
        <AnimatePresence>
          {showDiscoveryModal && discoveryResults && (
            <Modal
              title={discoveryResults.length > 1 ? 'Multiple Registry Index Files Found' : 'Registry Index Found'}
              onClose={cancelDiscovery}
              maxWidth={560}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                <div style={{
                  display: 'flex', gap: 14, padding: '14px 16px',
                  background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.2)',
                  borderRadius: 8,
                }}>
                  <FileSearch size={18} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <p style={{ margin: 0, fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      {discoveryResults.length > 1
                        ? `Found ${discoveryResults.length} valid registry index files for "${discoveryInput}". Select which one to use:`
                        : `Found a valid registry index file for "${discoveryInput}". Please confirm to add it:`}
                    </p>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {discoveryResults.map(entry => {
                    const isSelected = selectedDiscoveryUrl === entry.url;
                    return (
                      <div
                        key={entry.url}
                        onClick={() => {
                          setSelectedDiscoveryUrl(entry.url);
                          setSelectedDiscoveryModules(entry.modules);
                        }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '12px 14px',
                          background: isSelected ? 'var(--accent-dim)' : 'var(--bg-elevated)',
                          border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                          borderRadius: 'var(--radius)',
                          cursor: 'pointer',
                          transition: 'all 0.15s ease',
                        }}
                      >
                        <div style={{
                          width: 18, height: 18, borderRadius: '50%',
                          border: `2px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                          background: isSelected ? 'var(--accent)' : 'transparent',
                          flexShrink: 0,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          {isSelected && <CheckCircle size={12} color="#fff" />}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, overflow: 'hidden' }}>
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
                            {entry.url}
                          </span>
                          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 10, color: 'var(--text-muted)' }}>
                            {entry.modules.length} module{entry.modules.length !== 1 ? 's' : ''}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                  <button
                    className="btn btn-secondary"
                    style={{ flex: 1 }}
                    onClick={cancelDiscovery}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn btn-primary"
                    style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                    onClick={confirmDiscoverySelection}
                  >
                    <CheckCircle size={14} /> Confirm & Add
                  </button>
                </div>
              </div>
            </Modal>
          )}
        </AnimatePresence>

        {/* Duplicate Module Selection Modal */}
        <AnimatePresence>
          {showDuplicateModal && duplicateGroups.length > 0 && (
            <Modal title="Doppelte Module in Registries" onClose={cancelDuplicateSelections} maxWidth={560}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                <div style={{ display: 'flex', gap: 14, padding: '14px 16px', background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.16)', borderRadius: 8 }}>
                  <AlertTriangle size={18} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 2 }} />
                  <p style={{ margin: 0, fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    Folgende Module sind in mehreren Registries enthalten. Wähle pro Modul aus, aus welcher Registry es bezogen werden soll:
                  </p>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxHeight: 340, overflowY: 'auto', paddingRight: 4 }}>
                {duplicateGroups.map(dup => (
                  <div key={dup.id} style={{
                    background: 'var(--bg-hover)', border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)', padding: 14, display: 'flex', flexDirection: 'column', gap: 10
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontWeight: 700, fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--text-primary)' }}>
                        {dup.name}
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg-elevated)', padding: '2px 6px', borderRadius: 4, border: '1px solid var(--border)' }}>
                        ID: {dup.id}
                      </span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {dup.instances.map(inst => {
                        const regIdx = registries.findIndex(r => r.url === inst.registry_url);
                        const isSelected = selectedRegistryForMod[dup.id] === inst.registry_url;

                        return (
                          <div
                            key={inst.registry_url}
                            onClick={() => {
                              const next = { ...selectedRegistryForMod, [dup.id]: inst.registry_url };
                              setSelectedRegistryForMod(next);
                              filterAndSetModules(rawStoreModules, next);
                            }}
                            style={{
                              display: 'flex', flexDirection: 'column', gap: 6,
                              padding: '10px 12px',
                              background: isSelected ? 'var(--accent-dim)' : 'var(--bg-elevated)',
                              border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--border)'}`,
                              borderRadius: 'var(--radius)',
                              cursor: 'pointer',
                              transition: 'all 0.15s ease',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span style={{
                                  width: 20, height: 20, borderRadius: '50%',
                                  background: isSelected ? 'var(--accent)' : 'var(--bg-hover)',
                                  color: isSelected ? '#fff' : 'var(--text-muted)',
                                  fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700,
                                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
                                }}>
                                  {regIdx !== -1 ? regIdx + 1 : '?'}
                                </span>
                                <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                                  Registry #{regIdx !== -1 ? regIdx + 1 : '?'}
                                </span>
                                {inst.version && (
                                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>
                                    ({formatVersion(inst.version)})
                                  </span>
                                )}
                              </div>
                              <span style={{
                                fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 600,
                                color: isSelected ? 'var(--accent)' : 'var(--text-muted)',
                                display: 'flex', alignItems: 'center', gap: 4
                              }}>
                                {isSelected ? '✓ Ausgewählt' : 'Wählen'}
                              </span>
                            </div>
                            <div style={{
                              fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)',
                              wordBreak: 'break-all', lineHeight: 1.4, paddingLeft: 28
                            }}>
                              {inst.registry_url}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
                </div>

                <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                  <button
                    className="btn btn-secondary"
                    style={{ flex: 1 }}
                    onClick={cancelDuplicateSelections}
                  >
                    Abbrechen
                  </button>
                  <button
                    className="btn btn-primary"
                    style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                    onClick={confirmDuplicateSelections}
                  >
                    {pendingAddRegistryUrl ? 'Auswahl übernehmen & Registry hinzufügen' : 'Auswahl übernehmen'}
                  </button>
                </div>
              </div>
            </Modal>
          )}
        </AnimatePresence>

        {/* Version Picker Modal */}
        <AnimatePresence>
          {selectedModuleForVersionModal && (
            <Modal
              title={selectedModuleForVersionModal.installed ? `Switch Version: ${selectedModuleForVersionModal.name}` : `Install ${selectedModuleForVersionModal.name}`}
              onClose={() => setSelectedModuleForVersionModal(null)}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                <p style={{ margin: 0, fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--text-secondary)' }}>
                  Select a version from GitHub Releases:
                </p>

                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
                  background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.2)',
                  borderRadius: 'var(--radius)', fontSize: 11.5, fontFamily: 'var(--font-ui)',
                  color: 'var(--text-secondary)',
                }}>
                  <Info size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                  <span>Version list is cached and refreshed every 6 hours. Click the Refresh button in the Store to update it manually.</span>
                </div>

                {loadingReleases ? (
                  <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--text-muted)', padding: '12px 0' }}>
                    Fetching available releases from GitHub...
                  </div>
                ) : availableReleases.length === 0 ? (
                  <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--text-muted)', padding: '12px 0' }}>
                    No specific releases found. Default version will be installed.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 260, overflowY: 'auto' }}>
                    {availableReleases.map(rel => (
                      <label
                        key={rel.tag_name}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '10px 12px', border: `1px solid ${selectedReleaseTag === rel.tag_name ? 'var(--accent)' : 'var(--border)'}`,
                          borderRadius: 'var(--radius)', background: selectedReleaseTag === rel.tag_name ? 'var(--accent-dim)' : 'transparent',
                          cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: 13,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <input
                            type="radio"
                            name="release_version"
                            checked={selectedReleaseTag === rel.tag_name}
                            onChange={() => {
                              setSelectedReleaseTag(rel.tag_name);
                              setSelectedWasmUrl(rel.wasm_url);
                            }}
                          />
                          <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{formatVersion(rel.tag_name)}</span>
                        </div>
                        {rel.published_at && (
                          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                            {new Date(rel.published_at).toLocaleDateString()}
                          </span>
                        )}
                      </label>
                    ))}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                  <button
                    className="btn btn-secondary"
                    style={{ flex: 1 }}
                    onClick={() => setSelectedModuleForVersionModal(null)}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn btn-primary"
                    style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
                    disabled={busyId === selectedModuleForVersionModal.id}
                    onClick={confirmInstallWithVersion}
                  >
                    {busyId === selectedModuleForVersionModal.id
                      ? (selectedModuleForVersionModal.installed ? 'Switching…' : 'Installing…')
                      : (selectedModuleForVersionModal.installed ? 'Switch Version' : 'Install Version')}
                  </button>
                </div>
              </div>
            </Modal>
          )}
        </AnimatePresence>
      </div>
    </PageTransition>
  );
}

