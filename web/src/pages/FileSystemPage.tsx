import { useState, useEffect, useCallback } from 'react';
import { api, formatBytes } from '../api';
import PageTransition from '../components/PageTransition';
import ConfirmDialog from '../components/ConfirmDialog';
import { Folder, FileText, ChevronRight, RefreshCw, Trash2, Edit3, Upload, Download, ArrowLeft, Save, X, Home } from 'lucide-react';

interface FsEntry {
  name: string;
  is_dir: boolean;
  size: number;
  modified: number;
}

export default function FileSystemPage() {
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isFileView, setIsFileView] = useState(false);
  const [fileSize, setFileSize] = useState(0);

  // Editor state
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editLoading, setEditLoading] = useState(false);
  const [editDirty, setEditDirty] = useState(false);

  // Upload state
  const [uploadPath, setUploadPath] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  // Delete confirmation
  const [deletePath, setDeletePath] = useState<string | null>(null);

  const loadDir = useCallback(async (path: string) => {
    setLoading(true);
    setError('');
    try {
      const res = await api.fsList(path);
      if (res.is_file) {
        setIsFileView(true);
        setEntries([]);
        setFileSize(res.size || 0);
      } else {
        setIsFileView(false);
        setEntries(res.entries || []);
      }
      setCurrentPath(path);
      setEditingPath(null);
    } catch (err: any) {
      setError(err.message || 'Failed to list directory');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadDir(''); }, [loadDir]);

  const navigateTo = (name: string) => {
    const newPath = currentPath ? `${currentPath}/${name}` : name;
    loadDir(newPath);
  };

  const goUp = () => {
    if (!currentPath) return;
    const parts = currentPath.split('/');
    parts.pop();
    loadDir(parts.join('/'));
  };

  const breadcrumbs = currentPath ? currentPath.split('/') : [];

  const openFile = async (name: string) => {
    const path = currentPath ? `${currentPath}/${name}` : name;
    setEditLoading(true);
    setEditingPath(path);
    setEditDirty(false);
    try {
      const content = await api.fsRead(path);
      setEditContent(content);
    } catch (err: any) {
      setError(err.message || 'Failed to read file');
      setEditingPath(null);
    } finally {
      setEditLoading(false);
    }
  };

  const saveFile = async () => {
    if (!editingPath) return;
    setEditLoading(true);
    try {
      await api.fsWrite(editingPath, editContent);
      setEditDirty(false);
    } catch (err: any) {
      setError(err.message || 'Failed to save file');
    } finally {
      setEditLoading(false);
    }
  };

  const closeEditor = () => {
    if (editDirty && !confirm('Discard unsaved changes?')) return;
    setEditingPath(null);
    setEditContent('');
    setEditDirty(false);
  };

  const handleDelete = async () => {
    if (!deletePath) return;
    try {
      await api.fsDelete(deletePath);
      setDeletePath(null);
      loadDir(currentPath);
    } catch (err: any) {
      setError(err.message || 'Failed to delete');
      setDeletePath(null);
    }
  };

  const handleUpload = async () => {
    if (!uploadFile || !uploadPath) return;
    setUploading(true);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = (reader.result as string).split(',')[1];
        try {
          await api.fsUpload(uploadPath, base64);
          setUploadFile(null);
          setUploadPath('');
          setUploading(false);
          loadDir(currentPath);
        } catch (err: any) {
          setError(err.message || 'Upload failed');
          setUploading(false);
        }
      };
      reader.onerror = () => { setError('Failed to read file'); setUploading(false); };
      reader.readAsDataURL(uploadFile);
    } catch (err: any) {
      setError(err.message || 'Upload failed');
      setUploading(false);
    }
  };

  const downloadFile = async (name: string) => {
    const path = currentPath ? `${currentPath}/${name}` : name;
    try {
      const content = await api.fsRead(path);
      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.message || 'Download failed');
    }
  };

  const formatTime = (ts: number) => {
    if (!ts) return '-';
    return new Date(ts * 1000).toLocaleString();
  };

  return (
    <PageTransition>
      <div style={{ padding: '24px 32px', maxWidth: 1200, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <Folder size={24} color="var(--accent)" />
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>File System</h1>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0' }}>
              Browse, edit, upload, and delete files in /app
            </p>
          </div>
        </div>

        {error && (
          <div style={{ padding: '10px 14px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 'var(--radius)', marginBottom: 16, fontSize: 13, color: '#ef4444' }}>
            {error}
            <button onClick={() => setError('')} style={{ float: 'right', background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer' }}><X size={14} /></button>
          </div>
        )}

        {/* Toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <button onClick={() => loadDir('')} className="btn btn-secondary" style={{ height: 34, padding: '0 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Home size={14} /> Root
          </button>
          <button onClick={goUp} disabled={!currentPath} className="btn btn-secondary" style={{ height: 34, padding: '0 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, opacity: !currentPath ? 0.4 : 1 }}>
            <ArrowLeft size={14} /> Up
          </button>
          <button onClick={() => loadDir(currentPath)} className="btn btn-secondary" style={{ height: 34, padding: '0 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
            <RefreshCw size={14} /> Refresh
          </button>

          {/* Upload */}
          <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            <input
              type="text"
              placeholder="upload path (e.g. config.json)"
              value={uploadPath}
              onChange={e => setUploadPath(e.target.value)}
              style={{ height: 34, padding: '0 10px', fontSize: 12, background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text-primary)', width: 200 }}
            />
            <input
              type="file"
              onChange={e => setUploadFile(e.target.files?.[0] || null)}
              style={{ display: 'none' }}
              id="fs-upload-input"
            />
            <label htmlFor="fs-upload-input" className="btn btn-secondary" style={{ height: 34, padding: '0 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <Upload size={14} /> Choose
            </label>
            <button onClick={handleUpload} disabled={!uploadFile || !uploadPath || uploading} className="btn btn-primary" style={{ height: 34, padding: '0 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, opacity: (!uploadFile || !uploadPath || uploading) ? 0.4 : 1 }}>
              {uploading ? 'Uploading...' : 'Upload'}
            </button>
          </div>
        </div>

        {/* Breadcrumbs */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 12, fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          <span style={{ color: 'var(--accent)' }}>/app</span>
          {breadcrumbs.map((part, i) => (
            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <ChevronRight size={12} />
              <button
                onClick={() => loadDir(breadcrumbs.slice(0, i + 1).join('/'))}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 12, padding: 0 }}
              >
                {part}
              </button>
            </span>
          ))}
        </div>

        {/* File editor */}
        {editingPath !== null && (
          <div style={{ marginBottom: 16, border: '1px solid var(--accent)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--accent-dim)', borderBottom: '1px solid var(--border)' }}>
              <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>/{editingPath}</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={saveFile} disabled={editLoading || !editDirty} className="btn btn-primary" style={{ height: 28, padding: '0 10px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, opacity: (editLoading || !editDirty) ? 0.5 : 1 }}>
                  <Save size={12} /> Save
                </button>
                <button onClick={closeEditor} className="btn btn-secondary" style={{ height: 28, padding: '0 10px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <X size={12} /> Close
                </button>
              </div>
            </div>
            <textarea
              value={editContent}
              onChange={e => { setEditContent(e.target.value); setEditDirty(true); }}
              style={{ width: '100%', minHeight: 400, padding: 12, background: 'var(--bg-base)', border: 'none', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical', outline: 'none' }}
              spellCheck={false}
            />
          </div>
        )}

        {/* File listing */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)', fontSize: 13 }}>Loading...</div>
        ) : isFileView ? (
          <div style={{ padding: 20, textAlign: 'center', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
            <FileText size={32} style={{ color: 'var(--text-muted)', marginBottom: 8 }} />
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 12px' }}>
              {currentPath} — {formatBytes(fileSize)}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button onClick={() => openFile(currentPath.split('/').pop() || '')} className="btn btn-primary" style={{ height: 32, padding: '0 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Edit3 size={14} /> Edit
              </button>
              <button onClick={() => downloadFile(currentPath.split('/').pop() || '')} className="btn btn-secondary" style={{ height: 32, padding: '0 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Download size={14} /> Download
              </button>
              <button onClick={goUp} className="btn btn-secondary" style={{ height: 32, padding: '0 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                <ArrowLeft size={14} /> Back
              </button>
            </div>
          </div>
        ) : entries.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
            Empty directory
          </div>
        ) : (
          <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border)' }}>
                  <th style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Name</th>
                  <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', width: 100 }}>Size</th>
                  <th style={{ textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', width: 180 }}>Modified</th>
                  <th style={{ padding: '8px 12px', width: 120 }}></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)', transition: 'background 0.1s' }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                  >
                    <td style={{ padding: '8px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
                        onClick={() => entry.is_dir ? navigateTo(entry.name) : openFile(entry.name)}
                      >
                        {entry.is_dir
                          ? <Folder size={16} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                          : <FileText size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                        }
                        <span style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                          {entry.name}
                        </span>
                      </div>
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                      {entry.is_dir ? '-' : formatBytes(entry.size)}
                    </td>
                    <td style={{ padding: '8px 12px', color: 'var(--text-muted)', fontSize: 11 }}>
                      {formatTime(entry.modified)}
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                        {!entry.is_dir && (
                          <button onClick={() => downloadFile(entry.name)} title="Download" style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }}>
                            <Download size={14} />
                          </button>
                        )}
                        <button onClick={() => setDeletePath(currentPath ? `${currentPath}/${entry.name}` : entry.name)} title="Delete" style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {deletePath !== null && (
        <ConfirmDialog
          title="Delete file"
          message={`Delete "${deletePath}"? This cannot be undone.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setDeletePath(null)}
        />
      )}
    </PageTransition>
  );
}
