import React, { useEffect, useState, forwardRef, useImperativeHandle } from 'react';
import { Database, Server, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { api } from '../api';
import { useNotifications } from '../context/NotificationContext';

const inputStyle: React.CSSProperties = {
  width: '100%', height: 36, padding: '0 12px',
  background: 'var(--bg-base)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', color: 'var(--text-primary)',
  fontFamily: 'var(--font-ui)', fontSize: 13, outline: 'none',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  display: 'block', fontFamily: 'var(--font-ui)', fontSize: 11,
  fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase',
  letterSpacing: '0.06em', marginBottom: 6,
};

/// Ref handle: allows the parent to trigger the database save.
export interface DatabaseSectionRef {
  save: () => Promise<void>;
}

/**
 * Per-module database selection: each module can either use the internal
 * PostgreSQL (default) or its own external database connection.
 *
 * The save buttons have been removed — the parent (ModuleConfigForm)
 * triggers save() via a ref when "Save configuration" is clicked.
 */
const ModuleDatabaseSection = forwardRef<DatabaseSectionRef, { moduleId: string }>(({ moduleId }, ref) => {
  const { notify } = useNotifications();
  const [mode, setMode] = useState<'internal' | 'external'>('internal');
  const [form, setForm] = useState({ host: '', port: 5432, username: '', database: '', password: '' });
  const [hasPassword, setHasPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const patchForm = (patch: Partial<typeof form>) => {
    setForm(f => ({ ...f, ...patch }));
    setTestResult(null);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getModuleDatabase(moduleId);
        if (cancelled) return;
        setMode(res.mode);
        setForm({
          host: res.external.host,
          port: res.external.port || 5432,
          username: res.external.username,
          database: res.external.database,
          password: '',
        });
        setHasPassword(res.external.has_password);
      } catch { /* settings are non-critical */ }
    })();
    return () => { cancelled = true; };
  }, [moduleId]);

  const save = async () => {
    const res = await api.updateModuleDatabase(
      moduleId,
      mode === 'internal'
        ? { mode: 'internal' }
        : {
            mode: 'external',
            external: {
              host: form.host.trim(),
              port: Number(form.port) || 5432,
              username: form.username.trim(),
              database: form.database.trim(),
              ...(form.password ? { password: form.password } : {}),
            },
          }
    );
    setHasPassword(res.external.has_password);
    setForm(f => ({ ...f, password: '' }));
  };

  // Expose save to parent via ref
  useImperativeHandle(ref, () => ({ save }));

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.testModuleDatabase(moduleId, {
        host: form.host.trim(),
        port: Number(form.port) || 5432,
        username: form.username.trim(),
        database: form.database.trim(),
        ...(form.password ? { password: form.password } : {}),
      });
      setTestResult(res);
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div style={{
      background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', padding: 14, display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      {/* Header + mode switch */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{
          width: 28, height: 28, borderRadius: 'var(--radius)', flexShrink: 0,
          background: 'var(--accent-dim)', border: '1px solid var(--accent-mid)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Database size={13} style={{ color: 'var(--accent)' }} />
        </div>
        <div style={{ flex: 1, minWidth: 140 }}>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
            Datenbank
          </div>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
            Eigene Datenbank-Anbindung für dieses Modul
          </div>
        </div>
        <div style={{ display: 'flex', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden', flexShrink: 0 }}>
          {(['internal', 'external'] as const).map(m => {
            const active = mode === m;
            return (
              <button
                key={m}
                onClick={() => { setMode(m); setTestResult(null); }}
                style={{
                  height: 28, padding: '0 12px', border: 'none',
                  background: active ? 'var(--accent-dim)' : 'transparent',
                  color: active ? 'var(--accent)' : 'var(--text-muted)',
                  fontSize: 11, fontFamily: 'var(--font-ui)', fontWeight: 600,
                  cursor: 'pointer', transition: 'all 0.12s',
                  borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
                  display: 'flex', alignItems: 'center', gap: 5,
                  textTransform: 'capitalize',
                }}
              >
                {m === 'internal' ? <Database size={11} /> : <Server size={11} />}
                {m}
              </button>
            );
          })}
        </div>
      </div>

      {mode === 'internal' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <CheckCircle size={13} style={{ color: 'var(--success)', flexShrink: 0 }} />
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-secondary)', flex: 1, minWidth: 200 }}>
            Internes <strong style={{ color: 'var(--text-primary)' }}>PostgreSQL</strong> (Standard) — dieses Modul speichert seine Daten in der eingebetteten Datenbank.
          </span>
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <div>
              <label style={labelStyle}>IP-Adresse / Host *</label>
              <input
                type="text"
                value={form.host}
                onChange={e => patchForm({ host: e.target.value })}
                placeholder="z. B. 192.168.1.50"
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>Port</label>
              <input
                type="number"
                value={form.port}
                onChange={e => patchForm({ port: parseInt(e.target.value, 10) || 5432 })}
                placeholder="5432"
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>Username *</label>
              <input
                type="text"
                value={form.username}
                onChange={e => patchForm({ username: e.target.value })}
                placeholder="zfs_modules"
                autoComplete="off"
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>Passwort</label>
              <input
                type="password"
                value={form.password}
                onChange={e => patchForm({ password: e.target.value })}
                placeholder={hasPassword ? '••••••••  (gespeichert)' : 'Passwort'}
                autoComplete="new-password"
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>Datenbankname *</label>
              <input
                type="text"
                value={form.database}
                onChange={e => patchForm({ database: e.target.value })}
                placeholder="zfs_metrics"
                style={inputStyle}
              />
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn btn-secondary"
              style={{ height: 30, fontSize: 11, display: 'flex', alignItems: 'center', gap: 5, opacity: testing ? 0.6 : 1 }}
              disabled={testing || !form.host.trim() || !form.username.trim() || !form.database.trim()}
              onClick={test}
            >
              {testing ? <Loader2 size={12} className="spin" /> : <Server size={12} />}
              {testing ? 'Teste…' : 'Verbindung testen'}
            </button>
            {testResult && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 600,
                color: testResult.ok ? 'var(--success)' : 'var(--danger)',
              }}>
                {testResult.ok ? <CheckCircle size={12} /> : <XCircle size={12} />}
                {testResult.message}
              </span>
            )}
          </div>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Das Passwort wird verschlüsselt (AES-256-GCM) gespeichert. Leer lassen, um das gespeicherte Passwort beizubehalten.
          </div>
        </>
      )}
    </div>
  );
});

ModuleDatabaseSection.displayName = 'ModuleDatabaseSection';

export default ModuleDatabaseSection;
