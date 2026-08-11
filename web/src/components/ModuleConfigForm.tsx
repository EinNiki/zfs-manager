import React, { useRef, useState } from 'react';
import { ActiveModule, ModuleConfigField } from '../types';
import ModuleDatabaseSection, { DatabaseSectionRef } from './ModuleDatabaseSection';

const inputStyle: React.CSSProperties = {
  width: '100%', height: 38, padding: '0 12px',
  background: 'var(--bg-elevated)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', color: 'var(--text-primary)',
  fontFamily: 'var(--font-ui)', fontSize: 13, outline: 'none',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  display: 'block', fontFamily: 'var(--font-ui)', fontSize: 11,
  fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase',
  letterSpacing: '0.08em', marginBottom: 6,
};

interface Props {
  module: ActiveModule;
  onSave: (config: Record<string, unknown>, secrets: Record<string, string | null>) => Promise<void>;
}

/// Renders a config form generated from the module's config_schema.
/// Also embeds the database section — the single "Save configuration"
/// button saves both the module config and the database settings.
export default function ModuleConfigForm({ module, onSave }: Props) {
  const initialConfig: Record<string, unknown> = {};
  for (const field of module.config_schema) {
    if (field.type === 'secret') continue;
    initialConfig[field.key] = module.config[field.key] ?? field.default ?? (field.type === 'multiselect' ? [] : '');
  }
  const [config, setConfig] = useState<Record<string, unknown>>(initialConfig);
  // Secret inputs start empty; only touched keys are sent to the backend.
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const dbRef = useRef<DatabaseSectionRef>(null);

  const setValue = (key: string, value: unknown) => setConfig(c => ({ ...c, [key]: value }));

  const save = async () => {
    setSaving(true);
    try {
      // 1. Save module config + secrets
      const secrets: Record<string, string | null> = {};
      for (const key of Object.keys(secretInputs)) {
        if (secretInputs[key] !== '') secrets[key] = secretInputs[key];
      }
      await onSave(config, secrets);
      setSecretInputs({});

      // 2. Save database settings (best-effort — don't fail the whole
      //    save if the database section has an issue)
      try {
        await dbRef.current?.save();
      } catch {
        // Database save errors are non-critical — the config was already saved
      }
    } finally {
      setSaving(false);
    }
  };

  const renderField = (field: ModuleConfigField) => {
    if (field.type === 'secret') {
      const isSet = module.secret_keys_set.includes(field.key);
      return (
        <input
          style={inputStyle}
          type="password"
          autoComplete="new-password"
          placeholder={isSet ? '•••••••• (set — type to replace)' : 'not set'}
          value={secretInputs[field.key] ?? ''}
          onChange={e => setSecretInputs(s => ({ ...s, [field.key]: e.target.value }))}
        />
      );
    }
    const value = config[field.key];
    switch (field.type) {
      case 'number':
        return (
          <input
            style={inputStyle}
            type="number"
            value={value === '' || value === undefined ? '' : String(value)}
            onChange={e => setValue(field.key, e.target.value === '' ? '' : Number(e.target.value))}
          />
        );
      case 'select':
        return (
          <select
            style={inputStyle}
            value={String(value ?? '')}
            onChange={e => setValue(field.key, e.target.value)}
          >
            <option value="" disabled>Select…</option>
            {(field.options ?? []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
          </select>
        );
      case 'multiselect': {
        const selected = Array.isArray(value) ? (value as string[]) : [];
        return (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {(field.options ?? []).map(opt => {
              const active = selected.includes(opt);
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setValue(field.key, active ? selected.filter(s => s !== opt) : [...selected, opt])}
                  style={{
                    padding: '6px 12px', borderRadius: 'var(--radius)', cursor: 'pointer',
                    border: `1px solid ${active ? 'var(--accent-mid)' : 'var(--border)'}`,
                    background: active ? 'var(--accent-dim)' : 'transparent',
                    color: active ? 'var(--accent)' : 'var(--text-muted)',
                    fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 600,
                  }}
                >
                  {opt}
                </button>
              );
            })}
          </div>
        );
      }
      default:
        // text | textarea | url | schedule
        if (field.type === 'textarea') {
          return (
            <textarea
              style={{ ...inputStyle, height: 'auto', minHeight: 80, padding: '10px 12px', resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 12 }}
              placeholder={field.description || ''}
              value={String(value ?? '')}
              onChange={e => setValue(field.key, e.target.value)}
            />
          );
        }
        return (
          <input
            style={inputStyle}
            type="text"
            placeholder={field.type === 'schedule' ? 'e.g. 15m, 300 or 0 0 * * * *' : field.type === 'url' ? 'https://…' : ''}
            value={String(value ?? '')}
            onChange={e => setValue(field.key, e.target.value)}
          />
        );
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {module.config_schema.map(field => (
        <div key={field.key}>
          <label style={labelStyle}>
            {field.label}{field.required ? ' *' : ''}
          </label>
          {renderField(field)}
          {field.description && (
            <p style={{ fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'var(--text-muted)', margin: '5px 0 0', lineHeight: 1.4 }}>
              {field.description}
            </p>
          )}
        </div>
      ))}

      {/* Database section (no separate save button — saved by "Save configuration") */}
      <ModuleDatabaseSection ref={dbRef} moduleId={module.id} />

      <button
        onClick={save}
        disabled={saving}
        style={{
          alignSelf: 'flex-start', height: 36, padding: '0 18px',
          border: '1px solid var(--accent-mid)', borderRadius: 'var(--radius)',
          background: 'var(--accent-dim)', color: 'var(--accent)',
          fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600,
          cursor: 'pointer', opacity: saving ? 0.6 : 1,
        }}
      >
        {saving ? 'Saving…' : 'Save configuration'}
      </button>
    </div>
  );
}
