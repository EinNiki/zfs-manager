import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import PageTransition from '../components/PageTransition';
import { Database, Table2, RefreshCw, Play, ChevronRight, AlertTriangle, ChevronLeft, ChevronRight as ChevronRightIcon } from 'lucide-react';

export default function DatabasePage() {
  const [tables, setTables] = useState<string[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [columns, setColumns] = useState<any[]>([]);
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
    try {
      const res = await api.dbTableRows(name, lim, off);
      setColumns(res.columns);
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

  const formatValue = (val: any): string => {
    if (val === null) return 'NULL';
    if (val === undefined) return '';
    if (typeof val === 'object') return JSON.stringify(val);
    if (typeof val === 'boolean') return val ? 'true' : 'false';
    return String(val);
  };

  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  return (
    <PageTransition>
      <div style={{ padding: '24px 32px', maxWidth: 1400, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <Database size={24} color="var(--accent)" />
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>Database</h1>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
              Inspect tables and run SQL queries for debugging
            </p>
          </div>
        </div>

        {error && (
          <div style={{ padding: '10px 14px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 'var(--radius)', marginBottom: 16, fontSize: 13, color: '#ef4444' }}>
            {error}
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
                  </div>
                  <button onClick={() => loadTable(selectedTable, limit, offset)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2 }}>
                    <RefreshCw size={12} />
                  </button>
                </div>

                {loading ? (
                  <div style={{ padding: 40, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>Loading...</div>
                ) : rows.length === 0 ? (
                  <div style={{ padding: 40, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>No rows</div>
                ) : (
                  <div style={{ maxHeight: 500, overflow: 'auto' }} className="no-scrollbar">
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                      <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-elevated)', zIndex: 1 }}>
                        <tr>
                          {columns.map((col: any) => (
                            <th key={col.name} style={{ textAlign: 'left', padding: '6px 10px', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                              {col.name}
                              <span style={{ display: 'block', fontSize: 9, fontWeight: 400, textTransform: 'none', color: 'var(--text-muted)', opacity: 0.6, marginTop: 2 }}>
                                {col.type}
                              </span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}
                            onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'}
                            onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                          >
                            {columns.map((col: any) => (
                              <td key={col.name} style={{ padding: '4px 10px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                title={formatValue(row[col.name])}
                              >
                                {formatValue(row[col.name])}
                              </td>
                            ))}
                          </tr>
                        ))}
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
    </PageTransition>
  );
}
