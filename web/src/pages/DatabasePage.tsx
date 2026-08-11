import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import PageTransition from '../components/PageTransition';
import ConfirmDialog from '../components/ConfirmDialog';
import { Database, Table2, RefreshCw, Play, AlertTriangle, ChevronLeft, ChevronRight as ChevronRightIcon, Edit3, Trash2, Save, X, Plus } from 'lucide-react';

export default function DatabasePage() {
  const [tables, setTables] = useState<string[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [columns, setColumns] = useState<any[]>([]);
  const [pkColumns, setPkColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(100);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // SQL query
  const [sql, setSql] = useState('SELECT * FROM modules LIMIT 10;');
  const [readOnly, setReadOnly] = useState(true);
  const [queryResult, setQueryResult] = useState<any>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState('');

  // Inline editing
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [editValues, setEditValues] = useState<Record<string, any>>({});
  const [editSaving, setEditSaving] = useState(false);

  // Insert new row
  const [showInsert, setShowInsert] = useState(false);
  const [insertValues, setInsertValues] = useState<Record<string, any>>({});
  const [insertSaving, setInsertSaving] = useState(false);

  // Delete row
  const [deleteRowId, setDeleteRowId] = useState<Record<string, any> | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const loadTables = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.dbTables();
      setTables(res.tables);
    } catch (err: any) {
      setError(err.message || 'Failed to load tables');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTable = useCallback(async (name: string, lim = 100, off = 0) => {
    setLoading(true);
    setError('');
    setEditingRow(null);
    setShowInsert(false);
    try {
      const res = await api.dbTableRows(name, lim, off);
      setColumns(res.columns);
      setPkColumns(res.pk_columns || []);
      setRows(res.rows);
      setTotal(res.total);
      setLimit(res.limit);
      setOffset(res.offset);
      setSelectedTable(name);
    } catch (err: any) {
      setError(err.message || 'Failed to load table');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadTables(); }, [loadTables]);

  const runQuery = async () => {
    setQueryLoading(true);
    setQueryError('');
    setQueryResult(null);
    try {
      const res = await api.dbQuery(sql, readOnly);
      setQueryResult(res);
    } catch (err: any) {
      setQueryError(err.message || 'Query failed');
    } finally {
      setQueryLoading(false);
    }
  };

  // ── Inline editing ──
  const startEdit = (rowIndex: number) => {
    const row = rows[rowIndex];
    setEditingRow(rowIndex);
    setEditValues({ ...row });
  };

  const cancelEdit = () => {
    setEditingRow(null);
    setEditValues({});
  };

  const saveEdit = async () => {
    if (editingRow === null || !selectedTable) return;
    const row = rows[editingRow];
    // Build rowId from PK columns, or all columns if no PK
    const idCols = pkColumns.length > 0 ? pkColumns : Object.keys(row);
    const rowId: Record<string, any> = {};
    for (const col of idCols) {
      rowId[col] = row[col];
    }
    // Only send changed values
    const changedValues: Record<string, any> = {};
    for (const key of Object.keys(editValues)) {
      if (JSON.stringify(editValues[key]) !== JSON.stringify(row[key])) {
        changedValues[key] = editValues[key];
      }
    }
    if (Object.keys(changedValues).length === 0) {
      cancelEdit();
      return;
    }
    setEditSaving(true);
    try {
      await api.dbUpdateRow(selectedTable, changedValues, rowId);
      setEditingRow(null);
      setEditValues({});
      await loadTable(selectedTable, limit, offset);
    } catch (err: any) {
      setError(err.message || 'Failed to update row');
    } finally {
      setEditSaving(false);
    }
  };

  // ── Insert ──
  const startInsert = () => {
    const init: Record<string, any> = {};
    for (const col of columns) {
      if (col.is_pk) continue; // skip PK (usually auto-generated)
      init[col.name] = '';
    }
    setInsertValues(init);
    setShowInsert(true);
  };

  const doInsert = async () => {
    if (!selectedTable) return;
    setInsertSaving(true);
    try {
      await api.dbInsertRow(selectedTable, insertValues);
      setShowInsert(false);
      setInsertValues({});
      await loadTable(selectedTable, limit, offset);
    } catch (err: any) {
      setError(err.message || 'Failed to insert row');
    } finally {
      setInsertSaving(false);
    }
  };

  // ── Delete ──
  const confirmDelete = async () => {
    if (!deleteRowId || !selectedTable) return;
    setDeleteLoading(true);
    try {
      await api.dbDeleteRow(selectedTable, deleteRowId);
      setDeleteRowId(null);
      await loadTable(selectedTable, limit, offset);
    } catch (err: any) {
      setError(err.message || 'Failed to delete row');
      setDeleteRowId(null);
    } finally {
      setDeleteLoading(false);
    }
  };

  const formatValue = (val: any): string => {
    if (val === null) return 'NULL';
    if (val === undefined) return '';
    if (typeof val === 'object') return JSON.stringify(val);
    if (typeof val === 'boolean') return val ? 'true' : 'false';
    return String(val);
  };

  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;
  const canEdit = pkColumns.length > 0;

  return (
    <PageTransition>
      <div style={{ padding: '24px 32px', maxWidth: 1400, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <Database size={24} color="var(--accent)" />
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>Database</h1>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
              Inspect, edit, and query database tables for debugging
            </p>
          </div>
        </div>

        {error && (
          <div style={{ padding: '10px 14px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 'var(--radius)', marginBottom: 16, fontSize: 13, color: '#ef4444', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{error}</span>
            <button onClick={() => setError('')} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}><X size={14} /></button>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 16 }}>
          {/* Sidebar: table list */}
          <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Tables ({tables.length})
              </span>
              <button onClick={loadTables} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2 }}>
                <RefreshCw size={12} />
              </button>
            </div>
            <div style={{ maxHeight: 600, overflowY: 'auto' }} className="no-scrollbar">
              {loading && tables.length === 0 ? (
                <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>Loading...</div>
              ) : tables.map(t => (
                <button
                  key={t}
                  onClick={() => loadTable(t)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 12px', background: selectedTable === t ? 'var(--accent-dim)' : 'transparent',
                    border: 'none', borderBottom: '1px solid var(--border-subtle)',
                    cursor: 'pointer', textAlign: 'left', transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => { if (selectedTable !== t) (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
                  onMouseLeave={e => { if (selectedTable !== t) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                >
                  <Table2 size={14} style={{ color: selectedTable === t ? 'var(--accent)' : 'var(--text-muted)', flexShrink: 0 }} />
                  <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: selectedTable === t ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                    {t}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Main: table data + query */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* SQL Query */}
            <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
              <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>SQL Query</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-secondary)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={readOnly} onChange={e => setReadOnly(e.target.checked)} />
                  Read-only
                </label>
              </div>
              <textarea
                value={sql}
                onChange={e => setSql(e.target.value)}
                style={{ width: '100%', minHeight: 80, padding: 12, background: 'var(--bg-base)', border: 'none', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical', outline: 'none' }}
                spellCheck={false}
              />
              <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={runQuery} disabled={queryLoading} className="btn btn-primary" style={{ height: 30, padding: '0 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, opacity: queryLoading ? 0.5 : 1 }}>
                  <Play size={12} /> {queryLoading ? 'Running...' : 'Run'}
                </button>
                {!readOnly && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#f59e0b' }}>
                    <AlertTriangle size={12} /> Write mode — changes are permanent
                  </span>
                )}
              </div>

              {queryError && (
                <div style={{ padding: '10px 14px', background: 'rgba(239,68,68,0.08)', borderTop: '1px solid var(--border)', fontSize: 12, color: '#ef4444', fontFamily: 'var(--font-mono)' }}>
                  {queryError}
                </div>
              )}

              {queryResult && (
                <div style={{ borderTop: '1px solid var(--border)', maxHeight: 300, overflow: 'auto' }} className="no-scrollbar">
                  <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
                    {queryResult.rows_affected !== undefined
                      ? `${queryResult.rows_affected} row(s) affected`
                      : `${queryResult.row_count} row(s) returned`}
                  </div>
                  {queryResult.columns && (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                      <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-elevated)' }}>
                        <tr>
                          {queryResult.columns.map((col: string) => (
                            <th key={col} style={{ textAlign: 'left', padding: '6px 10px', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {queryResult.rows.map((row: any, i: number) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                            {queryResult.columns.map((col: string) => (
                              <td key={col} style={{ padding: '4px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {formatValue(row[col])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>

            {/* Table data */}
            {selectedTable && (
              <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
                <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Table2 size={14} style={{ color: 'var(--accent)' }} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>{selectedTable}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{total} rows</span>
                    {!canEdit && (
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                        (no PK — edit via SQL)
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {canEdit && (
                      <button onClick={startInsert} className="btn btn-primary" style={{ height: 28, padding: '0 10px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <Plus size={12} /> Insert
                      </button>
                    )}
                    <button onClick={() => loadTable(selectedTable, limit, offset)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2 }}>
                      <RefreshCw size={12} />
                    </button>
                  </div>
                </div>

                {loading ? (
                  <div style={{ padding: 40, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>Loading...</div>
                ) : rows.length === 0 && !showInsert ? (
                  <div style={{ padding: 40, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>No rows</div>
                ) : (
                  <div style={{ maxHeight: 500, overflow: 'auto' }} className="no-scrollbar">
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                      <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-elevated)', zIndex: 1 }}>
                        <tr>
                          {canEdit && <th style={{ width: 70, padding: '6px 8px', borderBottom: '1px solid var(--border)' }}></th>}
                          {columns.map((col: any) => (
                            <th key={col.name} style={{ textAlign: 'left', padding: '6px 10px', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                              {col.name}
                              {col.is_pk && <span style={{ color: 'var(--accent)', marginLeft: 4 }}>PK</span>}
                              <span style={{ display: 'block', fontSize: 9, fontWeight: 400, textTransform: 'none', color: 'var(--text-muted)', opacity: 0.6, marginTop: 2 }}>
                                {col.type}
                              </span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {/* Insert row */}
                        {showInsert && (
                          <tr style={{ borderBottom: '2px solid var(--accent)', background: 'var(--accent-dim)' }}>
                            {canEdit && (
                              <td style={{ padding: '4px 8px' }}>
                                <div style={{ display: 'flex', gap: 2 }}>
                                  <button onClick={doInsert} disabled={insertSaving} title="Save" style={{ background: 'none', border: 'none', color: 'var(--success)', cursor: 'pointer', padding: 2, opacity: insertSaving ? 0.5 : 1 }}>
                                    <Save size={13} />
                                  </button>
                                  <button onClick={() => setShowInsert(false)} title="Cancel" style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2 }}>
                                    <X size={13} />
                                  </button>
                                </div>
                              </td>
                            )}
                            {columns.map((col: any) => (
                              <td key={col.name} style={{ padding: '2px 4px' }}>
                                {col.is_pk ? (
                                  <span style={{ color: 'var(--text-muted)', fontSize: 10, fontStyle: 'italic' }}>auto</span>
                                ) : (
                                  <input
                                    type="text"
                                    value={insertValues[col.name] ?? ''}
                                    onChange={e => setInsertValues(v => ({ ...v, [col.name]: e.target.value }))}
                                    placeholder="NULL"
                                    style={{ width: '100%', minWidth: 60, padding: '3px 6px', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 11, outline: 'none', boxSizing: 'border-box' }}
                                  />
                                )}
                              </td>
                            ))}
                          </tr>
                        )}
                        {/* Data rows */}
                        {rows.map((row, i) => {
                          const isEditing = editingRow === i;
                          return (
                            <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)', background: isEditing ? 'var(--accent-dim)' : 'transparent' }}
                              onMouseEnter={e => { if (!isEditing) (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
                              onMouseLeave={e => { if (!isEditing) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                            >
                              {canEdit && (
                                <td style={{ padding: '4px 8px' }}>
                                  {isEditing ? (
                                    <div style={{ display: 'flex', gap: 2 }}>
                                      <button onClick={saveEdit} disabled={editSaving} title="Save" style={{ background: 'none', border: 'none', color: 'var(--success)', cursor: 'pointer', padding: 2, opacity: editSaving ? 0.5 : 1 }}>
                                        <Save size={13} />
                                      </button>
                                      <button onClick={cancelEdit} title="Cancel" style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2 }}>
                                        <X size={13} />
                                      </button>
                                    </div>
                                  ) : (
                                    <div style={{ display: 'flex', gap: 2 }}>
                                      <button onClick={() => startEdit(i)} title="Edit" style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2 }}>
                                        <Edit3 size={13} />
                                      </button>
                                      <button onClick={() => {
                                        const idCols = pkColumns.length > 0 ? pkColumns : Object.keys(row);
                                        const rowId: Record<string, any> = {};
                                        for (const col of idCols) rowId[col] = row[col];
                                        setDeleteRowId(rowId);
                                      }} title="Delete" style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2 }}>
                                        <Trash2 size={13} />
                                      </button>
                                    </div>
                                  )}
                                </td>
                              )}
                              {columns.map((col: any) => (
                                <td key={col.name} style={{ padding: isEditing ? '2px 4px' : '4px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                  title={isEditing ? undefined : formatValue(row[col.name])}
                                >
                                  {isEditing ? (
                                    <input
                                      type="text"
                                      value={editValues[col.name] === null ? 'NULL' : String(editValues[col.name] ?? '')}
                                      onChange={e => {
                                        const v = e.target.value;
                                        setEditValues(prev => ({ ...prev, [col.name]: v === 'NULL' ? null : v }));
                                      }}
                                      placeholder="NULL"
                                      style={{ width: '100%', minWidth: 60, padding: '3px 6px', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 11, outline: 'none', boxSizing: 'border-box' }}
                                    />
                                  ) : (
                                    formatValue(row[col.name])
                                  )}
                                </td>
                              ))}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Pagination */}
                {total > limit && (
                  <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      Page {currentPage} of {totalPages}
                    </span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        onClick={() => loadTable(selectedTable, limit, Math.max(0, offset - limit))}
                        disabled={offset === 0}
                        className="btn btn-secondary"
                        style={{ height: 28, padding: '0 10px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, opacity: offset === 0 ? 0.4 : 1 }}
                      >
                        <ChevronLeft size={12} /> Prev
                      </button>
                      <button
                        onClick={() => loadTable(selectedTable, limit, offset + limit)}
                        disabled={offset + limit >= total}
                        className="btn btn-secondary"
                        style={{ height: 28, padding: '0 10px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, opacity: offset + limit >= total ? 0.4 : 1 }}
                      >
                        Next <ChevronRightIcon size={12} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {deleteRowId !== null && (
        <ConfirmDialog
          title="Delete row"
          message={`Delete this row from "${selectedTable}"? This cannot be undone.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={confirmDelete}
          onCancel={() => setDeleteRowId(null)}
        />
      )}
    </PageTransition>
  );
}
