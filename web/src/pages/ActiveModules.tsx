import React, { useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import {
  Package, Play, Trash2, ChevronDown, ChevronUp,
  CheckCircle, XCircle, Clock, History, RefreshCw, ArrowUpCircle, Search
} from 'lucide-react';
import { api } from '../api';
import { ActiveModule, ModuleRun, StoreModule } from '../types';
import ModuleConfigForm from '../components/ModuleConfigForm';
import PageTransition from '../components/PageTransition';
import ConfirmDialog from '../components/ConfirmDialog';
import { useNotifications } from '../context/NotificationContext';
import { getActiveModulesCached, getModuleStoreForUpdateCheck, isUpdateAvailable } from '../utils/moduleCache';

const buttonStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  height: 32, padding: '0 12px', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', background: 'transparent',
  color: 'var(--text-secondary)', fontFamily: 'var(--font-ui)', fontSize: 12,
  fontWeight: 600, cursor: 'pointer',
};

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatVersion(version?: string): string {
  if (!version) return '';
  const trimmed = version.trim();
  if (!trimmed) return '';
  const clean = trimmed.replace(/^v+/i, '');
  return `v${clean}`;
}

function RunStatus({ success }: { success: boolean | null }) {
  if (success === null) return <Clock size={14} style={{ color: 'var(--warning)' }} />;
  return success
    ? <CheckCircle size={14} style={{ color: 'var(--success, #22c55e)' }} />
    : <XCircle size={14} style={{ color: 'var(--danger)' }} />;
}

export default function ActiveModules() {
  const { notify } = useNotifications();
  const [modules, setModules] = useState<ActiveModule[]>([]);
  const [storeModulesMap, setStoreModulesMap] = useState<Record<string, StoreModule>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, ModuleRun[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [uninstallTarget, setUninstallTarget] = useState<ActiveModule | null>(null);

  const reload = async (forceRefresh = false, silent = false) => {
    setLoading(true);
    try {
      const [activeRes, storeRes] = await Promise.all([
        getActiveModulesCached(forceRefresh),
        getModuleStoreForUpdateCheck(forceRefresh),
      ]);
      setModules(activeRes.modules);

      const map: Record<string, StoreModule> = {};
      storeRes.modules.forEach(m => { map[m.id] = m; });
      setStoreModulesMap(map);

      if (forceRefresh && !silent) {
        notify({ type: 'success', title: 'Active Modules', message: 'Module Cache erfolgreich aktualisiert.', toastOnly: true });
      }
    } catch (err) {
      notify({ type: 'error', title: 'Modules', message: `Failed to load modules: ${(err as Error).message}` });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, []);

  const loadRuns = async (id: string) => {
    try {
      const res = await api.getModuleRuns(id);
      setRuns(r => ({ ...r, [id]: res.runs }));
    } catch { /* run history is non-critical */ }
  };

  const toggleExpand = (id: string) => {
    const next = expanded === id ? null : id;
    setExpanded(next);
    if (next) loadRuns(next);
  };

  const toggleEnabled = async (mod: ActiveModule) => {
    try {
      await api.setModuleEnabled(mod.id, !mod.enabled);
      await reload(true, true);
    } catch (err) {
      notify({ type: 'error', title: 'Modules', message: `Toggle failed: ${(err as Error).message}` });
    }
  };

  const runNow = async (mod: ActiveModule) => {
    setBusy(mod.id);
    try {
      const result = await api.runModule(mod.id);
      notify({
        type: result.success ? 'success' : 'error',
        title: mod.name,
        message: result.success
          ? `Run finished: ${result.metrics_written} metrics written`
          : `Run failed: ${result.error ?? 'unknown error'}`,
      });
      await reload(true, true);
      await loadRuns(mod.id);
    } catch (err) {
      notify({ type: 'error', title: mod.name, message: `Run failed: ${(err as Error).message}` });
    } finally {
      setBusy(null);
    }
  };

  const uninstall = (mod: ActiveModule) => {
    setUninstallTarget(mod);
  };

  const confirmUninstall = async () => {
    const mod = uninstallTarget;
    if (!mod) return;
    setUninstallTarget(null);
    // Optimistic update: remove the module from the list immediately so the UI
    // stays fluid instead of waiting for the backend round-trip.
    setModules(prev => prev.filter(m => m.id !== mod.id));
    setExpanded(null);
    try {
      await api.uninstallModule(mod.id);
      notify({ type: 'success', title: 'Modules', message: `"${mod.name}" uninstalled` });
      await reload(true, true);
    } catch (err) {
      notify({ type: 'error', title: 'Modules', message: `Uninstall failed: ${(err as Error).message}` });
      await reload(true, true); // restore consistent state on failure
    }
  };

  const saveConfig = async (mod: ActiveModule, config: Record<string, unknown>, secrets: Record<string, string | null>) => {
    try {
      await api.updateModuleConfig(mod.id, config, secrets);
      notify({ type: 'success', title: mod.name, message: 'Configuration saved' });
      await reload(true, true);
    } catch (err) {
      notify({ type: 'error', title: mod.name, message: `Saving failed: ${(err as Error).message}` });
      throw err;
    }
  };

  return (
    <PageTransition>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontFamily: 'var(--font-ui)', fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.01em', margin: 0 }}>
              Active Modules
            </h1>
            <p style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)', marginTop: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              {modules.length} installed · schedules · configuration · run history
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
            <button className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: 6 }} onClick={() => reload(true)} disabled={loading} title="Cache leeren & Registries neu abfragen">
              <RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh
            </button>
          </div>
        </div>

        {!loading && modules.length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-ui)', fontSize: 13 }}>
            No modules installed yet — visit the Store to install one.
          </div>
        )}

        {modules.filter(mod => 
          mod.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
          mod.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
          mod.description.toLowerCase().includes(searchQuery.toLowerCase())
        ).map(mod => {
          const storeMod = storeModulesMap[mod.id];
          const hasUpdate = storeMod ? isUpdateAvailable(mod.version, storeMod.version) : false;

          return (
            <div key={mod.id} className="card" style={{ overflow: 'hidden' }}>
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', cursor: 'pointer' }}
                onClick={() => toggleExpand(mod.id)}
              >
                <div style={{
                  width: 34, height: 34, background: 'var(--accent-dim)',
                  border: '1px solid var(--accent-mid)', borderRadius: 'var(--radius)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <Package size={16} color="var(--accent)" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {mod.name}
                    </span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>
                      {formatVersion(mod.version)}{mod.source === 'sideload' ? ' · sideloaded' : ''}
                    </span>
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
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-muted)' }}>
                    {mod.last_run
                      ? <><RunStatus success={mod.last_run.success} /> Last run {formatTime(mod.last_run.started_at)}</>
                      : 'Never ran'}
                  </div>
                </div>

              <button
                onClick={e => { e.stopPropagation(); toggleEnabled(mod); }}
                title={mod.enabled ? 'Disable schedule' : 'Enable schedule'}
                style={{
                  width: 40, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer',
                  background: mod.enabled ? 'var(--accent)' : 'var(--border)',
                  position: 'relative', transition: 'background 0.15s ease', flexShrink: 0,
                }}
              >
                <span style={{
                  position: 'absolute', top: 3, left: mod.enabled ? 21 : 3,
                  width: 16, height: 16, borderRadius: '50%', background: '#fff',
                  transition: 'left 0.15s ease',
                }} />
              </button>
              {expanded === mod.id ? <ChevronUp size={16} color="var(--text-muted)" /> : <ChevronDown size={16} color="var(--text-muted)" />}
            </div>

            {expanded === mod.id && (
              <div style={{ borderTop: '1px solid var(--border)', padding: 16, display: 'flex', flexDirection: 'column', gap: 20 }}>
                <p style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'var(--text-secondary)', margin: 0 }}>
                  {mod.description}
                </p>

                {/* Dynamic Actions & Execution Buttons */}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button style={buttonStyle} disabled={busy === mod.id} onClick={() => runNow(mod)}>
                    <Play size={13} /> {busy === mod.id ? 'Running…' : 'Run now'}
                  </button>

                  {mod.actions?.map(act => (
                    <button
                      key={act.key}
                      style={{ ...buttonStyle, borderColor: 'var(--accent-mid)', color: 'var(--accent)' }}
                      disabled={busy === mod.id}
                      onClick={async () => {
                        try {
                          setBusy(mod.id);
                          const res = await api.executeModuleAction(mod.id, act.key);
                          notify({
                            type: res.success ? 'success' : 'error',
                            title: `${mod.name}: ${act.label}`,
                            message: res.message || (res.success ? 'Action executed' : 'Action failed'),
                          });
                          await reload();
                          await loadRuns(mod.id);
                        } catch (err) {
                          notify({ type: 'error', title: mod.name, message: `Action failed: ${(err as Error).message}` });
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      <Play size={13} /> {act.label}
                    </button>
                  ))}

                  <button
                    style={{ ...buttonStyle, color: 'var(--danger)' }}
                    onClick={() => uninstall(mod)}
                  >
                    <Trash2 size={13} /> Uninstall
                  </button>
                </div>


                <ModuleConfigForm
                  module={mod}
                  onSave={(config, secrets) => saveConfig(mod, config, secrets)}
                />

                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <History size={13} color="var(--text-muted)" />
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
                      Run history
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflowY: 'auto' }}>
                    {(runs[mod.id] ?? []).map(run => (
                      <div key={run.id} style={{
                        display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 10px',
                        background: 'rgba(255,255,255,0.02)', borderRadius: 'var(--radius)',
                        fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-secondary)',
                      }}>
                        <RunStatus success={run.success} />
                        <span style={{ whiteSpace: 'nowrap' }}>{formatTime(run.started_at)}</span>
                        <span style={{ color: 'var(--text-muted)' }}>{run.trigger}</span>
                        <span style={{ color: 'var(--text-muted)' }}>{run.metrics_written} metrics</span>
                        {run.message && (
                          <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 }}>
                            {run.message.length > 300 ? run.message.slice(0, 300) + '…' : run.message}
                          </span>
                        )}
                      </div>
                    ))}
                    {(runs[mod.id] ?? []).length === 0 && (
                      <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-muted)' }}>No runs yet.</span>
                    )}
                  </div>
                </div>
              </div>
            )}
           </div>
         );
       })}

      <AnimatePresence>
        {uninstallTarget && (
          <ConfirmDialog
            title="Modul deinstallieren"
            message={`Modul "${uninstallTarget.name}" wirklich deinstallieren? Konfiguration und Ausführungs-Verlauf werden gelöscht.`}
            confirmLabel="Deinstallieren"
            variant="danger"
            onConfirm={confirmUninstall}
            onCancel={() => setUninstallTarget(null)}
          />
        )}
      </AnimatePresence>
    </div>
  </PageTransition>
  );
}
