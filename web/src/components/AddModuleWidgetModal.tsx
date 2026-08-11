import React, { useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Plus, Search, Package, LineChart, BarChart3, Gauge, Hash, Blocks } from 'lucide-react';
import { api } from '../api';
import { ActiveModule, WidgetDefinition } from '../types';
import Modal from './Modal';
import { getActiveModulesCached } from '../utils/moduleCache';

interface AddModuleWidgetModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectWidget: (module: ActiveModule, widget: WidgetDefinition) => void;
}

function widgetTypeColor(type: string): string {
  switch (type) {
    case 'gauge': return 'var(--warning)';
    case 'stat':  return 'var(--success)';
    case 'bar':   return 'var(--accent)';
    default:      return 'var(--info)';
  }
}

function widgetTypeIcon(type: string) {
  const color = widgetTypeColor(type);
  switch (type) {
    case 'gauge': return <Gauge size={15} style={{ color }} />;
    case 'stat':  return <Hash size={15} style={{ color }} />;
    case 'bar':   return <BarChart3 size={15} style={{ color }} />;
    default:      return <LineChart size={15} style={{ color }} />;
  }
}

export default function AddModuleWidgetModal({ isOpen, onClose, onSelectWidget }: AddModuleWidgetModalProps) {
  const [activeModules, setActiveModules] = useState<ActiveModule[]>([]);
  const [widgetSearch, setWidgetSearch] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setWidgetSearch('');
      return;
    }

    let cancelled = false;
    setLoading(true);
    getActiveModulesCached()
      .then(res => {
        if (!cancelled) setActiveModules(res.modules || []);
      })
      .catch(err => {
        console.warn('Failed to load active modules for widget picker:', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [isOpen]);

  if (!isOpen) return null;

  const widgetQuery = widgetSearch.trim().toLowerCase();
  const widgetPickerModules = activeModules
    .map(mod => {
      const widgets = (mod.widget_schema || []).filter(w =>
        !widgetQuery ||
        w.label.toLowerCase().includes(widgetQuery) ||
        w.type.toLowerCase().includes(widgetQuery) ||
        mod.name.toLowerCase().includes(widgetQuery) ||
        w.metrics.some(m => m.toLowerCase().includes(widgetQuery))
      );
      return { mod, widgets };
    })
    .filter(({ widgets }) => widgetQuery ? widgets.length > 0 : true);

  const totalAvailableWidgets = activeModules.reduce((sum, m) => sum + (m.widget_schema?.length || 0), 0);

  return (
    <AnimatePresence>
      <Modal title="Add module widget" onClose={onClose} maxWidth={560}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
            <input
              type="text"
              className="input"
              placeholder="Search modules or metrics…"
              value={widgetSearch}
              onChange={e => setWidgetSearch(e.target.value)}
              style={{ paddingLeft: 34, width: '100%' }}
              autoFocus
            />
          </div>

          {loading ? (
            <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-muted)', fontFamily: 'var(--font-ui)', fontSize: 13 }}>
              Loading modules…
            </div>
          ) : totalAvailableWidgets === 0 ? (
            <div style={{
              background: 'var(--bg-elevated)', border: '1px dashed var(--border)',
              borderRadius: 'var(--radius)', padding: 32, textAlign: 'center',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
            }}>
              <Blocks size={28} color="var(--text-muted)" />
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                No module widgets available
              </div>
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-muted)', maxWidth: 360, lineHeight: 1.5 }}>
                Install community modules in the Module Store to add custom charts, stat cards, and visualizations here.
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxHeight: 420, overflowY: 'auto', paddingRight: 4 }}>
              {widgetPickerModules.map(({ mod, widgets }) => (
                <div key={mod.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 2, borderBottom: '1px solid var(--border-subtle)' }}>
                    <Package size={13} style={{ color: 'var(--accent)' }} />
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
                      {mod.name}
                    </span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
                      ({widgets.length})
                    </span>
                  </div>

                  {(!mod.widget_schema || mod.widget_schema.length === 0) ? (
                    <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', padding: '4px 2px' }}>
                      No widgets declared in manifest.
                    </div>
                  ) : widgets.length === 0 ? null : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {widgets.map(w => (
                        <button
                          key={w.key}
                          onClick={() => {
                            onSelectWidget(mod, w);
                            onClose();
                          }}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left',
                            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                            borderRadius: 'var(--radius)', padding: '10px 12px', cursor: 'pointer',
                            transition: 'border-color 0.12s ease, background 0.12s ease',
                          }}
                          onMouseEnter={e => {
                            (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent-mid)';
                            (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)';
                          }}
                          onMouseLeave={e => {
                            (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)';
                            (e.currentTarget as HTMLElement).style.background = 'var(--bg-elevated)';
                          }}
                        >
                          <div style={{
                            width: 34, height: 34, borderRadius: 'var(--radius)', flexShrink: 0,
                            background: 'var(--bg-base)', border: '1px solid var(--border)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}>
                            {widgetTypeIcon(w.type)}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                              {w.label}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                              <span style={{
                                fontFamily: 'var(--font-ui)', fontSize: 9, fontWeight: 800,
                                textTransform: 'uppercase', letterSpacing: '0.05em',
                                color: widgetTypeColor(w.type),
                                background: 'var(--bg-base)', border: '1px solid var(--border)',
                                borderRadius: 3, padding: '1px 5px',
                              }}>
                                {w.type}
                              </span>
                              {w.metrics.map(m => (
                                <span key={m} style={{
                                  fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)',
                                  background: 'var(--bg-base)', border: '1px solid var(--border)',
                                  borderRadius: 3, padding: '1px 5px',
                                }}>
                                  {m}
                                </span>
                              ))}
                            </div>
                          </div>
                          <div style={{
                            width: 26, height: 26, borderRadius: 'var(--radius)', flexShrink: 0,
                            background: 'var(--accent-dim)', border: '1px solid var(--accent-mid)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}>
                            <Plus size={13} style={{ color: 'var(--accent)' }} />
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>
    </AnimatePresence>
  );
}
