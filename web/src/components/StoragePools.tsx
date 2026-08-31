import React, { useState, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Database, RefreshCw, ChevronDown, CheckCircle, XCircle, Check,
  Loader2, Plus, Trash2, AlertTriangle, X, HardDrive,
  ArrowLeftRight, Download, Expand, RotateCcw, ChevronRight,
  Activity, Info, Cpu, Settings, Layers, Search,
} from 'lucide-react';
import { ZFSPool } from '../types';
import { api, formatBytes, formatSpeed } from '../api';
import { useNotifications } from '../context/NotificationContext';
import PageTransition from './PageTransition';
import { useIsMobile } from '../hooks/useBreakpoint';

interface StoragePoolsProps {
  pools: ZFSPool[];
  onRefresh: () => void;
  zfsVersion?: string;
}

type ScrubState = 'idle' | 'running' | 'success' | 'error';
type VdevType = 'stripe' | 'mirror' | 'raidz1' | 'raidz2' | 'raidz3';

interface ScrubProgress {
  inProgress: boolean;
  done: boolean;
  progress: number;
  timeRemaining: string;
  scan: string;
  scanDetail: string;
  isResilver: boolean;
  scanSpeed: string;
}

interface RewriteEntry {
  name: string;
  pool: string;
  total_bytes: number;
  processed_bytes: number;
  elapsed_secs: number;
  speed_bps?: number;
}

function fmtBytes(b: number): string { return formatBytes(b); }

function fmtSeconds(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return [h, m, sec].map(v => String(v).padStart(2, '0')).join(':');
}

function computeRewrite(r: RewriteEntry) {
  const total = r.total_bytes;
  const done  = r.processed_bytes;
  const pct   = total > 0 ? Math.min((done / total) * 100, 100) : 0;
  const speedBps = r.speed_bps ?? (r.elapsed_secs > 0 ? done / r.elapsed_secs : 100 * 1024 * 1024);
  const remS  = speedBps > 0 ? Math.max(total - done, 0) / speedBps : 0;
  const speedStr = formatSpeed(speedBps);
  return {
    pct,
    label: `Rewriting: ${fmtBytes(done)} / ${fmtBytes(total)} at ${speedStr}, ${pct.toFixed(2)}% done, ${fmtSeconds(remS)} to go`,
  };
}

interface ExpansionProgress {
  inProgress: boolean;
  vdev: string;
  progress: number;
  eta: string;
  speed: string;
  copied: string;
  detail: string;
}

const VDEV_INFO: Record<VdevType, { min: number; label: string; desc: string; color: string }> = {
  stripe: { min: 1, label: 'Stripe',  desc: 'Max performance, no redundancy',       color: 'var(--danger)'  },
  mirror: { min: 2, label: 'Mirror',  desc: 'Full redundancy, survives 1 disk loss', color: 'var(--success)' },
  raidz1: { min: 3, label: 'RAIDZ-1', desc: 'Single parity, min 3 devices',          color: 'var(--info)'    },
  raidz2: { min: 4, label: 'RAIDZ-2', desc: 'Double parity, min 4 devices',          color: 'var(--accent)'  },
  raidz3: { min: 5, label: 'RAIDZ-3', desc: 'Triple parity, min 5 devices',          color: 'var(--warning)' },
};

/* ── Small helpers ───────────────────────────────────────────────────────────── */
const S = {
  modal: {
    overlay: {
      position: 'fixed' as const, inset: 0, zIndex: 200,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16, background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)',
    },
    box: {
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)', padding: 28, width: '100%',
      maxWidth: 480, boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
    },
    title:  { fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'var(--font-ui)', margin: 0 },
    label:  { fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: 'var(--text-muted)', fontFamily: 'var(--font-ui)', display: 'block', marginBottom: 8 },
    input:  { width: '100%', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px 14px', fontSize: 13, color: 'var(--text-primary)', fontFamily: 'var(--font-mono)', outline: 'none', boxSizing: 'border-box' as const },
    select: { width: '100%', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px 14px', fontSize: 13, color: 'var(--text-primary)', fontFamily: 'var(--font-ui)', outline: 'none', cursor: 'pointer' },
  },
};

function iconBtn(onClick: () => void, icon: React.ReactNode, title: string, col = 'var(--text-muted)') {
  return (
    <button title={title} onClick={onClick} style={{
      width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg-elevated)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', cursor: 'pointer', color: col, transition: 'all 0.12s',
    }}>{icon}</button>
  );
}


/* ── Device Picker (legacy — used by Replace Disk only) ──────────────────────── */
function DevicePicker({ onSelect, onClose, usedDisks = new Set<string>() }: {
  onSelect: (path: string) => void;
  onClose: () => void;
  usedDisks?: Set<string>;
}) {
  const [disks, setDisks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getDisks()
      .then(res => setDisks(res.blockdevices || []))
      .catch(() => setDisks([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="modal-overlay" style={{ ...S.modal.overlay, zIndex: 300 }} onClick={onClose}>
      <div className="modal-box" style={{ ...S.modal.box, maxWidth: 440 }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <h4 style={S.modal.title}>Available Block Devices</h4>
            <p style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 3 }}>lsblk output</p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
            <X size={16} />
          </button>
        </div>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '32px 0', justifyContent: 'center', color: 'var(--text-muted)' }}>
            <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
            <span style={{ fontSize: 12, fontFamily: 'var(--font-ui)' }}>Scanning devices…</span>
          </div>
        ) : disks.length === 0 ? (
          <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: '24px 0' }}>No block devices found</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {disks.map((disk, i) => {
              const path = `/dev/${disk.name}`;
              const inUse = usedDisks.has(path);
              return (
                <button
                  key={i}
                  onClick={() => { if (!inUse) { onSelect(path); onClose(); } }}
                  disabled={inUse}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 14, padding: '10px 14px',
                    background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)', cursor: inUse ? 'not-allowed' : 'pointer',
                    textAlign: 'left', transition: 'all 0.12s',
                    opacity: inUse ? 0.5 : 1,
                  }}
                  onMouseEnter={e => { if (!inUse) (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; }}
                >
                  <HardDrive size={16} style={{ color: inUse ? 'var(--text-muted)' : 'var(--info)', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>{path}</span>
                      {inUse && (
                        <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap' }}>
                          In use
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{disk.model || ''} {disk.rota ? 'HDD' : 'SSD'}</div>
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: inUse ? 'var(--text-muted)' : 'var(--info)', fontWeight: 600 }}>{formatBytes(disk.size, 2)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Disk Picker (enriched — Expand Pool & Create Pool) ──────────────────────── */
interface EnrichedDisk {
  name: string; size_bytes: number; size_human: string;
  in_use: boolean; pool: string | null; partitions: boolean;
  model: string | null; serial: string | null; is_system: boolean;
}

function DiskStatusBadge({ disk }: { disk: EnrichedDisk }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      {disk.is_system && (
        <span style={{ fontSize: 10, color: '#fb923c', background: 'rgba(251,146,60,0.15)', border: '1px solid rgba(251,146,60,0.4)', borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap', fontWeight: 700 }}>⚠ OS DISK</span>
      )}
      {!disk.in_use ? (
        <span style={{ fontSize: 10, color: 'var(--success)', background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap', fontWeight: 600 }}>FREE</span>
      ) : disk.pool ? (
        <span style={{ fontSize: 10, color: '#f87171', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap', fontWeight: 600 }}>POOL: {disk.pool}</span>
      ) : (
        <span style={{ fontSize: 10, color: 'var(--warning)', background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap', fontWeight: 600 }}>IN USE</span>
      )}
    </span>
  );
}

function DiskPicker({ onSelect, onClose, selected, addedDisks = [], onlyFree = false }: {
  onSelect: (path: string) => void;
  onClose: () => void;
  selected?: string;
  addedDisks?: string[];
  onlyFree?: boolean;
}) {
  const [disks, setDisks]             = useState<EnrichedDisk[]>([]);
  const [loading, setLoading]         = useState(true);
  const [confirmDisk, setConfirmDisk] = useState<EnrichedDisk | null>(null);
  const addedSet = new Set(addedDisks.filter(Boolean));

  useEffect(() => {
    api.getEnrichedDisks()
      .then(res => setDisks(res.disks || []))
      .catch(() => setDisks([]))
      .finally(() => setLoading(false));
  }, []);

  const displayDisks = onlyFree ? disks.filter(d => !d.in_use) : disks;

  const handleClick = (disk: EnrichedDisk) => {
    const path = `/dev/${disk.name}`;
    if (addedSet.has(path)) return;
    if (disk.in_use) { setConfirmDisk(disk); return; }
    onSelect(path);
    onClose();
  };

  return (
    <div className="modal-overlay" style={{ ...S.modal.overlay, zIndex: 300 }} onClick={onClose}>
      <div className="modal-box" style={{ ...S.modal.box, maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <h4 style={S.modal.title}>Select Disk</h4>
            <p style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 3 }}>/api/v1/disks</p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}><X size={16} /></button>
        </div>

        {/* Inline confirmation warning for used disks */}
        {confirmDisk && (
          <div style={{ padding: '12px 14px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 'var(--radius)', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <AlertTriangle size={13} style={{ color: 'var(--danger)', flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: 'var(--danger)', fontWeight: 600 }}>Disk is in use!</span>
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '0 0 10px 0', lineHeight: 1.5 }}>
              {confirmDisk.pool
                ? `This disk belongs to pool "${confirmDisk.pool}". Adding it again may corrupt the pool.`
                : 'This disk has existing partitions. Using it may destroy data.'}
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary" style={{ flex: 1, fontSize: 11, padding: '5px 10px' }} onClick={() => setConfirmDisk(null)}>Cancel</button>
              <button className="btn btn-primary" style={{ flex: 1, fontSize: 11, padding: '5px 10px', background: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => { onSelect(`/dev/${confirmDisk.name}`); onClose(); }}>Use Anyway</button>
            </div>
          </div>
        )}

        {/* Disk list — all disks always shown */}
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '32px 0', justifyContent: 'center', color: 'var(--text-muted)' }}>
            <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
            <span style={{ fontSize: 12, fontFamily: 'var(--font-ui)' }}>Scanning devices…</span>
          </div>
        ) : displayDisks.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '28px 0' }}>
            <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              {onlyFree ? 'No free disks available — all disks are in a pool' : 'No block devices found'}
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
            {displayDisks.map((disk, i) => {
              const path = `/dev/${disk.name}`;
              const isSelected = selected === path;
              const isAdded = addedSet.has(path);
              const sysBorder = isAdded ? 'rgba(34,197,94,0.35)' : disk.is_system ? 'rgba(251,146,60,0.4)' : isSelected ? 'var(--accent-mid)' : 'var(--border)';
              const sysBg = isAdded ? 'rgba(34,197,94,0.06)' : disk.is_system ? 'rgba(251,146,60,0.06)' : isSelected ? 'var(--accent-dim)' : 'var(--bg-elevated)';
              return (
              <button
                key={i}
                onClick={() => handleClick(disk)}
                disabled={isAdded}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                  background: sysBg,
                  border: `1px solid ${sysBorder}`,
                  borderRadius: 'var(--radius)', cursor: isAdded ? 'default' : 'pointer', textAlign: 'left',
                  opacity: (disk.in_use && !isSelected && !isAdded) ? 0.65 : 1, transition: 'all 0.12s',
                }}
                onMouseEnter={e => { if (!disk.in_use && !isAdded) (e.currentTarget as HTMLElement).style.borderColor = disk.is_system ? 'rgba(251,146,60,0.7)' : 'var(--accent)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = sysBorder; }}
              >
                <HardDrive size={16} style={{ color: isAdded ? 'var(--success)' : disk.in_use ? 'var(--text-muted)' : 'var(--info)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>/dev/{disk.name}</span>
                    {isAdded && (
                      <span style={{ fontSize: 10, color: 'var(--success)', background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 4, padding: '1px 6px', fontWeight: 700, flexShrink: 0 }}>✓ ADDED</span>
                    )}
                    {!isAdded && <DiskStatusBadge disk={disk} />}
                  </div>
                  {(disk.model || disk.serial) && (
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {[disk.model, disk.serial].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: isAdded ? 'var(--success)' : disk.in_use ? 'var(--text-muted)' : 'var(--text-secondary)', fontWeight: 600, minWidth: 60, textAlign: 'right', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                  {disk.size_human}
                </span>
              </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Inline Disk Picker (embedded in modal body, no overlay) ─────────────────── */
function InlineDiskPicker({ selected, onSelect, onlyFree = false }: {
  selected: string;
  onSelect: (path: string) => void;
  onlyFree?: boolean;
}) {
  const [disks, setDisks]             = useState<EnrichedDisk[]>([]);
  const [loading, setLoading]         = useState(true);
  const [confirmDisk, setConfirmDisk] = useState<EnrichedDisk | null>(null);

  useEffect(() => {
    api.getEnrichedDisks()
      .then(res => setDisks(res.disks || []))
      .catch(() => setDisks([]))
      .finally(() => setLoading(false));
  }, []);

  // When onlyFree is true, only show disks not already in a ZFS pool
  const displayDisks = onlyFree ? disks.filter(d => !d.in_use) : disks;

  const handleClick = (disk: EnrichedDisk) => {
    if (disk.in_use) { setConfirmDisk(disk); return; }
    onSelect(`/dev/${disk.name}`);
  };

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
      {confirmDisk && (
        <div style={{ padding: '10px 12px', background: 'rgba(239,68,68,0.08)', borderBottom: '1px solid rgba(239,68,68,0.3)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <AlertTriangle size={13} style={{ color: 'var(--danger)', flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: 'var(--danger)', fontWeight: 600 }}>Disk is in use!</span>
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: '0 0 8px 0', lineHeight: 1.5 }}>
            {confirmDisk.pool
              ? `This disk belongs to pool "${confirmDisk.pool}". Using it may corrupt data.`
              : 'This disk has partitions. Using it may destroy data.'}
          </p>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-secondary" style={{ flex: 1, fontSize: 11, padding: '4px 8px' }} onClick={() => setConfirmDisk(null)}>Cancel</button>
            <button className="btn btn-primary" style={{ flex: 1, fontSize: 11, padding: '4px 8px', background: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => { onSelect(`/dev/${confirmDisk.name}`); setConfirmDisk(null); }}>Use Anyway</button>
          </div>
        </div>
      )}
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '24px 0', justifyContent: 'center', color: 'var(--text-muted)' }}>
          <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
          <span style={{ fontSize: 12, fontFamily: 'var(--font-ui)' }}>Scanning…</span>
        </div>
      ) : displayDisks.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: 0 }}>
            {onlyFree ? 'No free disks available — all disks are already in a pool' : 'No block devices found'}
          </p>
        </div>
      ) : (
        <div style={{ maxHeight: 260, overflowY: 'auto' }}>
          {displayDisks.map((disk, i) => {
            const path = `/dev/${disk.name}`;
            const isSelected = selected === path;
            const sysAccent = 'rgba(251,146,60,0.7)';
            return (
              <button
                key={i}
                onClick={() => handleClick(disk)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
                  background: disk.is_system ? 'rgba(251,146,60,0.05)' : isSelected ? 'var(--accent-dim)' : 'var(--bg-elevated)',
                  border: 'none', borderBottom: '1px solid var(--border)',
                  borderLeft: `3px solid ${disk.is_system ? sysAccent : isSelected ? 'var(--accent)' : 'transparent'}`,
                  cursor: 'pointer', textAlign: 'left', width: '100%',
                  opacity: disk.in_use && !isSelected ? 0.65 : 1,
                }}
              >
                <HardDrive size={13} style={{ color: isSelected ? 'var(--accent)' : disk.in_use ? 'var(--text-muted)' : 'var(--info)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: isSelected ? 'var(--accent)' : 'var(--text-primary)', fontWeight: 600 }}>{path}</span>
                    {disk.is_system && <span style={{ fontSize: 10, color: '#fb923c', background: 'rgba(251,146,60,0.15)', border: '1px solid rgba(251,146,60,0.4)', borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap', fontWeight: 700, flexShrink: 0 }}>⚠ OS DISK</span>}
                    {!onlyFree && !disk.is_system && <DiskStatusBadge disk={disk} />}
                  </div>
                  {(disk.model || disk.serial) && (
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {[disk.model, disk.serial].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{disk.size_human}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── SMART Modal ──────────────────────────────────────────────────────────────── */
function SmartModal({ device, onClose }: { device: string; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [enrichedDisk, setEnrichedDisk] = useState<EnrichedDisk | null>(null);

  useEffect(() => {
    const shortName = device.replace(/^\/dev\//, '');
    Promise.all([
      api.getSmartData(device).then(setData).catch(() => setData(null)),
      api.getEnrichedDisks().then(res => {
        const found = (res.disks || []).find((d: EnrichedDisk) => d.name === shortName);
        setEnrichedDisk(found || null);
      }).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, [device]);

  const passed    = data?.smart_status?.passed;
  const temp      = data?.temperature?.current;
  const hours     = data?.power_on_time?.hours;
  const attrs     = data?.ata_smart_attributes?.table || [];
  const modelName = data?.model_name || data?.scsi_model_name || enrichedDisk?.model || null;
  const serial    = data?.serial_number || enrichedDisk?.serial || null;
  const firmware  = data?.firmware_version || null;
  const capacityBytes: number | null = data?.user_capacity?.bytes ?? null;
  const sizeHuman = capacityBytes ? null : (enrichedDisk?.size_human || null);
  const isOnline  = data !== null && !data?.message;

  // ZFS pool state (ground truth): ONLINE / FAULTED / OFFLINE / DEGRADED / NOT_IN_POOL
  const zfsState: string | undefined = data?.zfs_disk_state;
  const inPool = zfsState && zfsState !== 'NOT_IN_POOL';

  // Health: use ZFS pool state as primary source (reliable for SCSI/virtual disks).
  // Fall back to SMART passed only when the disk is not in any pool.
  const zfsHealthy  = zfsState === 'ONLINE' || zfsState === 'AVAIL';
  const zfsWarn     = zfsState === 'DEGRADED' || zfsState === 'INUSE';
  const zfsFailed   = inPool && !zfsHealthy && !zfsWarn;

  const healthValue = inPool
    ? zfsState!
    : (passed === true ? 'PASSED' : passed === false ? 'FAILED' : 'N/A');
  const healthColor =
    zfsHealthy      ? 'var(--success)' :
    zfsWarn         ? 'var(--warning)' :
    zfsFailed       ? 'var(--danger)'  :
    passed === true ? 'var(--success)' :
    passed === false? 'var(--danger)'  :
    'var(--text-muted)';
  const healthBorder =
    zfsHealthy      ? 'rgba(34,197,94,0.3)'  :
    zfsWarn         ? 'rgba(245,158,11,0.3)' :
    zfsFailed       ? 'rgba(239,68,68,0.3)'  :
    passed === true ? 'rgba(34,197,94,0.3)'  :
    passed === false? 'rgba(239,68,68,0.3)'  :
    'var(--border)';

  const tempColor   = temp !== undefined && temp > 0
    ? (temp > 55 ? 'var(--danger)' : temp > 45 ? 'var(--warning)' : 'var(--success)')
    : 'var(--text-muted)';

  return (
    <div className="modal-overlay" style={S.modal.overlay} onClick={onClose}>
      <div className="modal-box" style={{ ...S.modal.box, maxWidth: 520, maxHeight: '85vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <h4 style={S.modal.title}>SMART Data</h4>
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>/dev/{device.replace(/^\/dev\//, '')}</p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}><X size={16} /></button>
        </div>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '32px 0', justifyContent: 'center', color: 'var(--text-muted)' }}>
            <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
            <span style={{ fontSize: 12 }}>Reading SMART data…</span>
          </div>
        ) : !data ? (
          <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, padding: '24px 0' }}>No SMART data available</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* Top row: Status + Online + Temp + Power-On — all in one line */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
              {/* Health Status — sourced from ZFS pool state when available */}
              <div style={{ background: 'var(--bg-elevated)', border: `1px solid ${healthBorder}`, borderRadius: 'var(--radius)', padding: '10px 12px', textAlign: 'center' }}>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 5 }}>Health</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: healthColor }}>{healthValue}</div>
              </div>
              {/* Online status */}
              <div style={{ background: 'var(--bg-elevated)', border: `1px solid ${isOnline ? 'rgba(34,197,94,0.3)' : 'var(--border)'}`, borderRadius: 'var(--radius)', padding: '10px 12px', textAlign: 'center' }}>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 5 }}>Status</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: isOnline ? 'var(--success)' : 'var(--danger)' }}>{isOnline ? 'ONLINE' : 'OFFLINE'}</div>
              </div>
              {/* Temperature */}
              <div style={{ background: 'var(--bg-elevated)', border: `1px solid ${temp !== undefined && temp > 45 ? 'rgba(245,158,11,0.3)' : 'var(--border)'}`, borderRadius: 'var(--radius)', padding: '10px 12px', textAlign: 'center' }}>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 5 }}>Temp</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: tempColor }}>
                  {temp !== undefined && temp > 0 ? `${temp}°C` : 'N/A'}
                </div>
              </div>
              {/* Power-On Hours */}
              <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px 12px', textAlign: 'center' }}>
                <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 5 }}>Power-On</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
                  {hours !== undefined ? (hours >= 8760 ? `${(hours/8760).toFixed(1)}y` : `${(hours/24).toFixed(0)}d`) : 'N/A'}
                </div>
              </div>
            </div>

            {/* Device info — compact key/value table */}
            <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
              {[
                { label: 'Model',    value: modelName },
                { label: 'Serial',   value: serial },
                { label: 'Firmware', value: firmware },
                { label: 'Capacity', value: capacityBytes !== null ? formatBytes(capacityBytes) : sizeHuman },
              ].filter(r => r.value).map((row, i, arr) => (
                <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 14px', borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', flexShrink: 0 }}>{row.label}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, textAlign: 'right', wordBreak: 'break-all' }}>{row.value}</span>
                </div>
              ))}
              {![modelName, serial, firmware, capacityBytes].some(Boolean) && (
                <div style={{ padding: '12px 14px', fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>No device identity data available</div>
              )}
            </div>

            {attrs.length > 0 && (
              <div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Attributes</div>
                <div style={{ maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {attrs.map((a: any, i: number) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 10px', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-sm)' }}>
                      <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{a.name}</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: a.thresh > 0 && a.value <= a.thresh ? 'var(--danger)' : 'var(--text-muted)', fontWeight: 600 }}>{a.raw?.value ?? a.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Replace Disk Modal ───────────────────────────────────────────────────────── */
function ReplaceDiskModal({ poolName, poolDisks, preselectedDisk, onClose, onSuccess }: {
  poolName: string; poolDisks: { path: string; state: string }[];
  preselectedDisk?: string; onClose: () => void; onSuccess: () => void;
}) {
  const [selectedOld, setSelectedOld] = useState(preselectedDisk || '');
  const [newDisk, setNewDisk]         = useState('');
  const [force, setForce]             = useState(false);
  const [replacing, setReplacing]     = useState(false);
  const [error, setError]             = useState('');
  const [step, setStep]               = useState<1 | 2>(preselectedDisk ? 2 : 1);
  const [enrichedDisks, setEnrichedDisks] = useState<EnrichedDisk[]>([]);

  // Sync step/selectedOld whenever preselectedDisk changes (handles modal reuse)
  useEffect(() => {
    if (preselectedDisk) {
      setSelectedOld(preselectedDisk);
      setStep(2);
    } else {
      setStep(1);
    }
  }, [preselectedDisk]);

  useEffect(() => {
    api.getEnrichedDisks()
      .then(res => setEnrichedDisks(res.disks || []))
      .catch(() => {});
  }, []);

  const getEnrichedInfo = (path: string): EnrichedDisk | null => {
    const name = path.replace(/^\/dev\//, '');
    return enrichedDisks.find(d => d.name === name) || null;
  };

  const handleReplace = async () => {
    if (!selectedOld) { setError('Select the disk to replace'); return; }
    if (!newDisk.trim()) { setError('Select a replacement disk'); return; }
    setReplacing(true); setError('');
    try { await api.replaceDisk(poolName, selectedOld, newDisk.trim(), force); onSuccess(); }
    catch (err: any) { setError(err.message || 'Replace failed'); }
    finally { setReplacing(false); }
  };

  const stateColor = (s: string) =>
    s === 'ONLINE' ? 'var(--success)' : s === 'DEGRADED' ? 'var(--warning)' : 'var(--danger)';

  return (
    <div className="modal-overlay" style={S.modal.overlay} onClick={onClose}>
      <div className="modal-box" style={{ ...S.modal.box, maxWidth: 500, maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <h3 style={S.modal.title}>Replace Disk</h3>
            <p style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 3 }}>
              zpool replace {poolName}{step === 2 && selectedOld ? ` · replacing ${selectedOld}` : ''}
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}><X size={16} /></button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {step === 1 ? (
            <>
              <label style={S.modal.label}>Select disk to replace</label>
              {poolDisks.length === 0 ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px', background: 'var(--bg-elevated)', borderRadius: 'var(--radius)', color: 'var(--text-muted)', fontSize: 12 }}>
                  <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Loading pool disks…
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {poolDisks.map((d, i) => {
                    const info = getEnrichedInfo(d.path);
                    const isSelected = selectedOld === d.path;
                    const sc = stateColor(d.state);
                    return (
                    <button key={i} onClick={() => setSelectedOld(d.path)} style={{
                      display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                      background: isSelected ? 'var(--warning-dim)' : 'var(--bg-elevated)',
                      border: `1px solid ${isSelected ? 'rgba(245,158,11,0.5)' : 'var(--border)'}`,
                      borderRadius: 'var(--radius)', cursor: 'pointer', textAlign: 'left', transition: 'all 0.12s', width: '100%',
                    }}>
                      <HardDrive size={14} style={{ color: isSelected ? 'var(--warning)' : sc, flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {/* Disk name prominently */}
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-primary)', fontWeight: 700 }}>
                          {d.path}
                        </div>
                        {/* State badge */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                          <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: sc }}>{d.state}</span>
                          {info?.size_human && (
                            <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{info.size_human}</span>
                          )}
                        </div>
                        {/* Model */}
                        {info?.model && (
                          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {info.model}
                          </div>
                        )}
                      </div>
                      {isSelected && <CheckCircle size={14} style={{ color: 'var(--warning)', flexShrink: 0 }} />}
                    </button>
                    );
                  })}
                </div>
              )}
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn btn-secondary" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
                <button className="btn btn-primary" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                  onClick={() => { if (selectedOld) setStep(2); }}
                  disabled={!selectedOld}
                >
                  <ChevronRight size={14} /> Next
                </button>
              </div>
            </>
          ) : (
            <>
              {/* Show which disk is being replaced with its state */}
              {(() => {
                const replacingDisk = poolDisks.find(d => d.path === selectedOld);
                const info = getEnrichedInfo(selectedOld);
                const sc = replacingDisk ? stateColor(replacingDisk.state) : 'var(--text-muted)';
                return (
                  <div style={{ background: 'var(--warning-dim)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 'var(--radius)', padding: '12px 14px' }}>
                    <div style={{ fontSize: 9, color: 'var(--warning)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Replacing</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <HardDrive size={14} style={{ color: sc, flexShrink: 0 }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-primary)', fontWeight: 700 }}>{selectedOld}</div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                          {replacingDisk && <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: sc }}>{replacingDisk.state}</span>}
                          {info?.size_human && <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{info.size_human}</span>}
                          {info?.model && <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{info.model}</span>}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}
              <label style={S.modal.label}>Select replacement disk</label>
              <InlineDiskPicker selected={newDisk} onSelect={setNewDisk} onlyFree={true} />
              {newDisk && (() => {
                const info = getEnrichedInfo(newDisk);
                if (!info) return null;
                const diskLabel = newDisk.replace(/^\/dev\//, '');
                return (
                  <div style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.2)', borderRadius: 'var(--radius)', padding: '10px 14px' }}>
                    <div style={{ fontSize: 9, color: 'var(--success)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Selected Replacement</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>{diskLabel}</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {info.model   && <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>Model: {info.model}</div>}
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>Size: {info.size_human}</div>
                      {info.serial  && <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>Serial: {info.serial}</div>}
                    </div>
                  </div>
                );
              })()}
              <label style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}>
                <div onClick={() => setForce(v => !v)} style={{ width: 36, height: 20, borderRadius: 10, background: force ? 'var(--warning)' : 'var(--bg-elevated)', border: '1px solid var(--border)', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
                  <div style={{ position: 'absolute', top: 2, left: force ? 17 : 2, width: 14, height: 14, borderRadius: 7, background: '#fff', transition: 'left 0.2s' }} />
                </div>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-ui)' }}>Force replace (-f)</span>
              </label>
              {error && (
                <div style={{ display: 'flex', gap: 10, padding: '10px 14px', background: 'var(--danger-dim)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 'var(--radius)' }}>
                  <XCircle size={14} style={{ color: 'var(--danger)', flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: 'var(--danger)' }}>{error}</span>
                </div>
              )}
              <div style={{ display: 'flex', gap: 10 }}>
                {!preselectedDisk && (
                  <button className="btn btn-secondary" onClick={() => setStep(1)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <ChevronDown size={13} style={{ transform: 'rotate(90deg)' }} /> Back
                  </button>
                )}
                <button className="btn btn-primary" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={handleReplace} disabled={replacing || !newDisk.trim()}>
                  {replacing ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <ArrowLeftRight size={14} />}
                  {replacing ? 'Replacing…' : 'Replace'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Import Pool Modal ────────────────────────────────────────────────────────── */
interface ImportConfig {
  name: string;
  key_file?: string;
  encrypted: boolean;
  import_on_startup: boolean;
  enabled: boolean;
  bind_mounts: Array<{ source: string; target: string }>;
  dataset_keys: Array<{ dataset: string; key_file: string }>;
  mountpoint_override?: string;
}

/* ── Auto-Mount Config Modal (per-pool) ─────────────────────────────────────── */
function AutoMountModal({ poolName, onClose, onSuccess }: { poolName: string; onClose: () => void; onSuccess: () => void }) {
  const { notify } = useNotifications();
  const [loading, setLoading]               = useState(true);
  const [existing, setExisting]             = useState<ImportConfig | null>(null);
  const [enabled, setEnabled]               = useState(true);
  const [onStartup, setOnStartup]           = useState(true);
  const [encrypted, setEncrypted]           = useState(false);
  const [keyFile, setKeyFile]               = useState('');
  const [datasetKeys, setDatasetKeys]       = useState<Array<{ dataset: string; key_file: string }>>([]);
  const [bindMounts, setBindMounts]         = useState<Array<{ source: string; target: string }>>([]);
  const [mountpointOverride, setMountpointOverride] = useState('');
  const [saving, setSaving]                 = useState(false);
  const [running, setRunning]               = useState(false);
  const [error, setError]                   = useState('');

  useEffect(() => {
    api.getImportConfigs()
      .then(res => {
        const found = (res.configs || []).find((c: ImportConfig) => c.name === poolName);
        if (found) {
          setExisting(found);
          setEnabled(found.enabled);
          setOnStartup(found.import_on_startup);
          setEncrypted(found.encrypted);
          setKeyFile(found.key_file || '');
          setDatasetKeys(found.dataset_keys?.map(d => ({ ...d })) || []);
          setBindMounts(found.bind_mounts?.map(b => ({ ...b })) || []);
          setMountpointOverride(found.mountpoint_override || '');
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [poolName]);

  const buildPayload = (): ImportConfig => ({
    name: poolName,
    encrypted,
    key_file: encrypted && keyFile.trim() ? keyFile.trim() : undefined,
    import_on_startup: onStartup,
    enabled,
    bind_mounts: bindMounts.filter(b => b.source.trim() && b.target.trim()),
    dataset_keys: datasetKeys.filter(d => d.dataset.trim() && d.key_file.trim()),
    mountpoint_override: mountpointOverride.trim() || undefined,
  });

  const handleSave = async () => {
    setSaving(true); setError('');
    const payload = buildPayload();
    try {
      if (existing) await api.updateImportConfig(poolName, payload);
      else          await api.saveImportConfig(payload);
      notify({ type: 'success', title: 'Mount Config Saved', message: `Auto-mount config for "${poolName}" saved` });
      onSuccess();
    } catch (err: any) { setError(err.message || 'Save failed'); }
    finally { setSaving(false); }
  };

  const handleRunNow = async () => {
    setRunning(true); setError('');
    const payload = buildPayload();
    try {
      if (existing) await api.updateImportConfig(poolName, payload);
      else          await api.saveImportConfig(payload);
      await api.runImportConfig(poolName);
      notify({ type: 'success', title: 'Mount Executed', message: `Config saved and pool "${poolName}" mounted successfully` });
      onSuccess();
    } catch (err: any) { setError(err.message || 'Mount failed'); }
    finally { setRunning(false); }
  };

  const toggleEl = (value: boolean, onChange: (v: boolean) => void) => (
    <button onClick={() => onChange(!value)} style={{ width: 36, height: 20, borderRadius: 10, background: value ? 'var(--accent)' : 'var(--bg-elevated)', border: `1px solid ${value ? 'var(--accent)' : 'var(--border)'}`, position: 'relative', cursor: 'pointer', transition: 'all 0.2s', flexShrink: 0 }}>
      <div style={{ position: 'absolute', top: 2, left: value ? 17 : 2, width: 14, height: 14, borderRadius: 7, background: '#fff', transition: 'left 0.2s' }} />
    </button>
  );

  return (
    <div className="modal-overlay" style={S.modal.overlay} onClick={onClose}>
      <div className="modal-box" style={{ ...S.modal.box, maxWidth: 540, maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h3 style={S.modal.title}>Auto-Mount Config</h3>
              <span style={{ fontSize: 10, fontWeight: 700, color: '#fff', background: '#ef4444', borderRadius: 4, padding: '2px 6px', letterSpacing: '0.05em', fontFamily: 'var(--font-ui)' }}>BETA</span>
            </div>
            <p style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 3 }}>{poolName}</p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}><X size={16} /></button>
        </div>

        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '32px 0', justifyContent: 'center', color: 'var(--text-muted)' }}>
            <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
            <span style={{ fontSize: 12 }}>Loading config…</span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Toggles */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
              {[
                { label: 'Enabled',             desc: 'Include this pool in startup mount sequence', val: enabled,   set: setEnabled },
                { label: 'Import on startup',   desc: 'Run zpool import if pool is not yet imported', val: onStartup, set: setOnStartup },
                { label: 'Encrypted dataset',   desc: 'Load encryption keys before mounting',          val: encrypted, set: setEncrypted },
              ].map(({ label, desc, val, set }, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: i < 2 ? '1px solid var(--border)' : 'none' }}>
                  <div>
                    <div style={{ fontSize: 13, color: 'var(--text-primary)', fontFamily: 'var(--font-ui)' }}>{label}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-ui)', marginTop: 2 }}>{desc}</div>
                  </div>
                  {toggleEl(val, set)}
                </div>
              ))}
            </div>

            {/* Pool key file */}
            {encrypted && (
              <div>
                <label style={S.modal.label}>Pool key file path</label>
                <input style={{ ...S.modal.input, fontFamily: 'var(--font-mono)' }} type="text" placeholder="/root/pool.key" value={keyFile} onChange={e => setKeyFile(e.target.value)} />
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>Loaded with: zfs load-key -L file://…</div>
              </div>
            )}

            {/* Dataset keys */}
            {encrypted && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <label style={{ ...S.modal.label, marginBottom: 0 }}>Dataset key files</label>
                  <button className="btn btn-secondary" style={{ padding: '3px 10px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}
                    onClick={() => setDatasetKeys(d => [...d, { dataset: `${poolName}/`, key_file: '' }])}>
                    <Plus size={11} /> Add Dataset
                  </button>
                </div>
                {datasetKeys.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>No per-dataset keys configured</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {datasetKeys.map((dk, i) => (
                      <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input style={{ ...S.modal.input, flex: 1.2, fontFamily: 'var(--font-mono)', fontSize: 11 }} placeholder={`${poolName}/dataset`} value={dk.dataset} onChange={e => setDatasetKeys(d => d.map((v, j) => j === i ? { ...v, dataset: e.target.value } : v))} />
                        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>→</span>
                        <input style={{ ...S.modal.input, flex: 1, fontFamily: 'var(--font-mono)', fontSize: 11 }} placeholder="/root/dataset.key" value={dk.key_file} onChange={e => setDatasetKeys(d => d.map((v, j) => j === i ? { ...v, key_file: e.target.value } : v))} />
                        <button onClick={() => setDatasetKeys(d => d.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', padding: 4 }}>
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Mountpoint Override — directly sets zfs mountpoint property */}
            <div>
              <label style={S.modal.label}>Pool Mountpoint <span style={{ color: 'var(--text-muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></label>
              <input
                style={{ ...S.modal.input, fontFamily: 'var(--font-mono)' }}
                type="text"
                placeholder={`/mnt/${poolName}`}
                value={mountpointOverride}
                onChange={e => setMountpointOverride(e.target.value)}
              />
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
                Sets the ZFS mountpoint directly: <code style={{ fontFamily: 'var(--font-mono)' }}>zfs set mountpoint=… {poolName}</code><br/>
                Files written here go into the pool. Leave empty to keep the current mountpoint.
              </div>
            </div>

            {/* Bind mounts */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <label style={{ ...S.modal.label, marginBottom: 0 }}>Bind mounts (mount --rbind)</label>
                <button className="btn btn-secondary" style={{ padding: '3px 10px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}
                  onClick={() => setBindMounts(b => [...b, { source: '', target: '' }])}>
                  <Plus size={11} /> Add
                </button>
              </div>
              {bindMounts.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>No bind mounts configured</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {bindMounts.map((bm, i) => (
                    <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input style={{ ...S.modal.input, flex: 1, fontFamily: 'var(--font-mono)', fontSize: 11 }} placeholder="source" value={bm.source} onChange={e => setBindMounts(b => b.map((v, j) => j === i ? { ...v, source: e.target.value } : v))} />
                      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>→</span>
                      <input style={{ ...S.modal.input, flex: 1, fontFamily: 'var(--font-mono)', fontSize: 11 }} placeholder="target" value={bm.target} onChange={e => setBindMounts(b => b.map((v, j) => j === i ? { ...v, target: e.target.value } : v))} />
                      <button onClick={() => setBindMounts(b => b.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', padding: 4 }}>
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Script preview */}
            <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px 14px' }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Script preview</div>
              <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
{`#!/bin/bash
# zpool import if not already imported
if ! zpool list "${poolName}" >/dev/null 2>&1; then
  zpool import "${poolName}"
fi
${encrypted && keyFile ? `\n# Load pool encryption key\nzfs load-key -L file://${keyFile} "${poolName}"` : ''}${datasetKeys.filter(d => d.dataset && d.key_file).map(d => `\nzfs load-key -L file://${d.key_file} "${d.dataset}"`).join('')}${encrypted || datasetKeys.length > 0 ? '\n' : ''}
# Mount all datasets
zfs mount -a
${bindMounts.filter(b => b.source && b.target).map(b => `\n# Bind mount\nmkdir -p "${b.target}"\nmount --rbind "${b.source}" "${b.target}"`).join('')}`}
              </pre>
            </div>

            {error && (
              <div style={{ padding: '10px 14px', background: 'var(--danger-dim)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 'var(--radius)', fontSize: 12, color: 'var(--danger)' }}>{error}</div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
              {existing && (
                <button className="btn btn-secondary" onClick={handleRunNow} disabled={running} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                  {running ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Download size={13} />}
                  {running ? 'Mounting…' : 'Run Now'}
                </button>
              )}
              <button className="btn btn-primary" onClick={handleSave} disabled={saving} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                {saving ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={13} />}
                {saving ? 'Saving…' : 'Save Config'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ImportPoolModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [tab, setTab] = useState<'import' | 'configs'>('import');

  // Import tab state
  const [importable, setImportable] = useState<any[]>([]);
  const [scanning, setScanning]     = useState(true);
  const [poolName, setPoolName]     = useState('');
  const [dir, setDir]               = useState('');
  const [importing, setImporting]   = useState(false);
  const [importError, setImportError] = useState('');

  // Config tab state
  const [configs, setConfigs]             = useState<ImportConfig[]>([]);
  const [configsLoading, setConfigsLoading] = useState(true);
  const [editingConfig, setEditingConfig] = useState<ImportConfig | null>(null);
  const [cfgName, setCfgName]             = useState('');
  const [cfgEncrypted, setCfgEncrypted]   = useState(false);
  const [cfgKeyFile, setCfgKeyFile]       = useState('');
  const [cfgOnStartup, setCfgOnStartup]   = useState(true);
  const [cfgEnabled, setCfgEnabled]       = useState(true);
  const [cfgBindMounts, setCfgBindMounts] = useState<Array<{ source: string; target: string }>>([]);
  const [cfgSaving, setCfgSaving]         = useState(false);
  const [cfgError, setCfgError]           = useState('');
  const [showCfgForm, setShowCfgForm]     = useState(false);
  const [runningConfig, setRunningConfig] = useState<string | null>(null);

  useEffect(() => {
    api.getImportablePools()
      .then(res => setImportable(res.pools || []))
      .catch(() => setImportable([]))
      .finally(() => setScanning(false));
    loadConfigs();
  }, []);

  const loadConfigs = () => {
    setConfigsLoading(true);
    api.getImportConfigs()
      .then(res => setConfigs(res.configs || []))
      .catch(() => setConfigs([]))
      .finally(() => setConfigsLoading(false));
  };

  const handleImport = async () => {
    if (!poolName.trim()) { setImportError('Pool name is required'); return; }
    setImporting(true); setImportError('');
    try { await api.importPool(poolName.trim(), dir.trim() || undefined); onSuccess(); }
    catch (err: any) { setImportError(err.message || 'Import failed'); }
    finally { setImporting(false); }
  };

  const openNewConfig = () => {
    setEditingConfig(null);
    setCfgName(''); setCfgEncrypted(false); setCfgKeyFile('');
    setCfgOnStartup(true); setCfgEnabled(true); setCfgBindMounts([]);
    setCfgError(''); setShowCfgForm(true);
  };

  const openEditConfig = (c: ImportConfig) => {
    setEditingConfig(c);
    setCfgName(c.name); setCfgEncrypted(c.encrypted); setCfgKeyFile(c.key_file || '');
    setCfgOnStartup(c.import_on_startup); setCfgEnabled(c.enabled);
    setCfgBindMounts(c.bind_mounts.map(b => ({ ...b })));
    setCfgError(''); setShowCfgForm(true);
  };

  const saveConfig = async () => {
    if (!cfgName.trim()) { setCfgError('Pool name is required'); return; }
    setCfgSaving(true); setCfgError('');
    const payload: ImportConfig = {
      name: cfgName.trim(), encrypted: cfgEncrypted,
      key_file: cfgEncrypted && cfgKeyFile.trim() ? cfgKeyFile.trim() : undefined,
      import_on_startup: cfgOnStartup, enabled: cfgEnabled,
      bind_mounts: cfgBindMounts.filter(b => b.source.trim() && b.target.trim()),
      dataset_keys: [],
    };
    try {
      if (editingConfig) await api.updateImportConfig(editingConfig.name, payload);
      else               await api.saveImportConfig(payload);
      setShowCfgForm(false); loadConfigs();
    } catch (err: any) { setCfgError(err.message || 'Save failed'); }
    finally { setCfgSaving(false); }
  };

  const deleteConfig = async (name: string) => {
    try { await api.deleteImportConfig(name); loadConfigs(); } catch { /* ignore */ }
  };

  const runConfig = async (name: string) => {
    setRunningConfig(name);
    try { await api.runImportConfig(name); onSuccess(); }
    catch { /* ignore */ }
    finally { setRunningConfig(null); }
  };

  const addBindMount = () => setCfgBindMounts(b => [...b, { source: '', target: '' }]);
  const removeBindMount = (i: number) => setCfgBindMounts(b => b.filter((_, j) => j !== i));
  const updateBindMount = (i: number, field: 'source' | 'target', val: string) =>
    setCfgBindMounts(b => b.map((bm, j) => j === i ? { ...bm, [field]: val } : bm));

  const tabBtn = (active: boolean): React.CSSProperties => ({
    padding: '6px 14px', fontSize: 12, fontFamily: 'var(--font-ui)',
    background: active ? 'var(--accent-dim)' : 'transparent',
    border: active ? '1px solid var(--accent-mid)' : '1px solid transparent',
    borderRadius: 'var(--radius)', cursor: 'pointer',
    color: active ? 'var(--accent)' : 'var(--text-muted)', fontWeight: active ? 600 : 400,
  });

  return (
    <div className="modal-overlay" style={S.modal.overlay} onClick={onClose}>
      <div className="modal-box" style={{ ...S.modal.box, maxWidth: 560, width: '100%', maxHeight: '85vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h3 style={S.modal.title}>Import Pool</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}><X size={16} /></button>
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
          <button style={tabBtn(tab === 'import')}  onClick={() => setTab('import')}>One-time Import</button>
          <button style={tabBtn(tab === 'configs')} onClick={() => setTab('configs')}>Import Configs</button>
        </div>

        {tab === 'import' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {scanning ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 0', justifyContent: 'center', color: 'var(--text-muted)' }}>
                <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
                <span style={{ fontSize: 12 }}>Scanning for importable pools…</span>
              </div>
            ) : importable.length > 0 && (
              <div>
                <label style={S.modal.label}>Detected Pools</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {importable.map((p, i) => (
                    <button key={i} onClick={() => setPoolName(p.name)} style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px',
                      background: poolName === p.name ? 'var(--accent-dim)' : 'var(--bg-elevated)',
                      border: `1px solid ${poolName === p.name ? 'var(--accent-mid)' : 'var(--border)'}`,
                      borderRadius: 'var(--radius)', cursor: 'pointer', transition: 'all 0.12s',
                    }}>
                      <span style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>{p.name}</span>
                      <span className={p.state === 'ONLINE' ? 'badge badge-success' : 'badge badge-warning'}>{p.state || 'UNKNOWN'}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div>
              <label style={S.modal.label}>Pool Name</label>
              <input style={S.modal.input} type="text" placeholder="e.g. tank" value={poolName} onChange={e => setPoolName(e.target.value)} />
            </div>
            <div>
              <label style={S.modal.label}>Search Directory (optional)</label>
              <input style={{ ...S.modal.input, fontFamily: 'var(--font-mono)' }} type="text" placeholder="/mnt/disk1" value={dir} onChange={e => setDir(e.target.value)} />
            </div>
            {importError && (
              <div style={{ padding: '10px 14px', background: 'var(--danger-dim)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 'var(--radius)', fontSize: 12, color: 'var(--danger)' }}>{importError}</div>
            )}
            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={handleImport} disabled={importing || !poolName.trim()}>
                {importing ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Download size={14} />}
                {importing ? 'Importing…' : 'Import Pool'}
              </button>
            </div>
          </div>
        )}

        {tab === 'configs' && !showCfgForm && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {configsLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '16px 0', color: 'var(--text-muted)' }}>
                <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
              </div>
            ) : configs.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-muted)', fontSize: 13 }}>No import configs yet</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {configs.map(c => (
                  <div key={c.name} style={{ padding: '12px 14px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{c.name}</span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-secondary" style={{ padding: '3px 10px', fontSize: 11 }} onClick={() => runConfig(c.name)} disabled={runningConfig === c.name}>
                          {runningConfig === c.name ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : 'Run'}
                        </button>
                        <button className="btn btn-secondary" style={{ padding: '3px 10px', fontSize: 11 }} onClick={() => openEditConfig(c)}>Edit</button>
                        <button className="btn btn-secondary" style={{ padding: '3px 10px', fontSize: 11, color: 'var(--danger)' }} onClick={() => deleteConfig(c.name)}>
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <span className={c.enabled ? 'badge badge-success' : 'badge'}>{c.enabled ? 'Enabled' : 'Disabled'}</span>
                      {c.import_on_startup && <span className="badge badge-info">Auto-import</span>}
                      {c.encrypted && <span className="badge badge-warning">Encrypted</span>}
                      {c.bind_mounts.length > 0 && <span className="badge">{c.bind_mounts.length} bind mount{c.bind_mounts.length !== 1 ? 's' : ''}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={onClose}>Close</button>
              <button className="btn btn-primary" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={openNewConfig}>
                <Plus size={13} /> New Config
              </button>
            </div>
          </div>
        )}

        {tab === 'configs' && showCfgForm && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>
              {editingConfig ? `Edit: ${editingConfig.name}` : 'New Import Config'}
            </div>
            <div>
              <label style={S.modal.label}>Pool Name</label>
              <input style={S.modal.input} type="text" placeholder="e.g. tank" value={cfgName} onChange={e => setCfgName(e.target.value)} disabled={!!editingConfig} />
            </div>
            <div style={{ display: 'flex', gap: 20 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-primary)', cursor: 'pointer' }}>
                <input type="checkbox" checked={cfgEnabled} onChange={e => setCfgEnabled(e.target.checked)} /> Enabled
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-primary)', cursor: 'pointer' }}>
                <input type="checkbox" checked={cfgOnStartup} onChange={e => setCfgOnStartup(e.target.checked)} /> Auto-import on startup
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-primary)', cursor: 'pointer' }}>
                <input type="checkbox" checked={cfgEncrypted} onChange={e => setCfgEncrypted(e.target.checked)} /> Encrypted
              </label>
            </div>
            {cfgEncrypted && (
              <div>
                <label style={S.modal.label}>Key File Path (optional)</label>
                <input style={{ ...S.modal.input, fontFamily: 'var(--font-mono)' }} type="text" placeholder="/etc/zfs/keys/tank.key" value={cfgKeyFile} onChange={e => setCfgKeyFile(e.target.value)} />
              </div>
            )}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <label style={S.modal.label}>Bind Mounts</label>
                <button className="btn btn-secondary" style={{ padding: '3px 10px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }} onClick={addBindMount}>
                  <Plus size={11} /> Add
                </button>
              </div>
              {cfgBindMounts.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '6px 0' }}>None configured</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {cfgBindMounts.map((bm, i) => (
                    <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input
                        style={{ ...S.modal.input, flex: 1, fontFamily: 'var(--font-mono)', fontSize: 11 }}
                        placeholder="source"
                        value={bm.source}
                        onChange={e => updateBindMount(i, 'source', e.target.value)}
                      />
                      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>→</span>
                      <input
                        style={{ ...S.modal.input, flex: 1, fontFamily: 'var(--font-mono)', fontSize: 11 }}
                        placeholder="target"
                        value={bm.target}
                        onChange={e => updateBindMount(i, 'target', e.target.value)}
                      />
                      <button onClick={() => removeBindMount(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', padding: 4 }}>
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {cfgError && (
              <div style={{ padding: '10px 14px', background: 'var(--danger-dim)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 'var(--radius)', fontSize: 12, color: 'var(--danger)' }}>{cfgError}</div>
            )}
            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setShowCfgForm(false)}>Back</button>
              <button className="btn btn-primary" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={saveConfig} disabled={cfgSaving || !cfgName.trim()}>
                {cfgSaving ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={13} />}
                {cfgSaving ? 'Saving…' : 'Save Config'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Expand Pool Modal ────────────────────────────────────────────────────────── */
function ExpandPoolModal({ poolName, poolVdevs, zfsVersion, onClose, onSuccess }: {
  poolName: string;
  poolVdevs: any[];
  zfsVersion?: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [expanding, setExpanding]     = useState(false);
  const [error, setError]             = useState('');
  const [mode, setMode]               = useState<'extend' | 'cache' | 'spare'>('extend');
  const [cacheType, setCacheType]     = useState<'l2arc' | 'slog'>('l2arc');
  const [disk, setDisk]               = useState('');
  const [raidzEnabled, setRaidzEnabled] = useState<boolean | null>(null);

  const dataVdevs = poolVdevs.filter((v: any) => !['log', 'cache', 'spare'].includes(v.type));
  const [expandMode, setExpandMode] = useState<'new' | 'attach'>(dataVdevs.length > 0 ? 'attach' : 'new');
  const [targetVdev, setTargetVdev] = useState(dataVdevs.length > 0 ? (dataVdevs[0].name || dataVdevs[0].type || '') : '');

  // All disk short names already in this pool (e.g. "sde", "sdb")
  const poolDiskNames = new Set<string>(
    poolVdevs.flatMap((v: any) => (v.disks || []).map((d: any) => (d.path || '').replace(/^\/dev\//, '')))
  );

  // zpool attach (RAIDZ expansion) requires OpenZFS >= 2.1
  const attachSupported = (() => {
    if (!zfsVersion) return true;
    const m = zfsVersion.match(/(\d+)\.(\d+)/);
    if (!m) return true;
    return parseInt(m[1]) * 100 + parseInt(m[2]) >= 201;
  })();

  useEffect(() => {
    api.getRaidzExpansionFeature(poolName)
      .then(res => setRaidzEnabled(res.enabled))
      .catch(() => setRaidzEnabled(false));
  }, [poolName]);

  const ready = disk.trim() !== '';
  const targetForPreview = targetVdev || '<target_vdev>';

  const modeLabels: Record<string, string> = { extend: 'Extend Pool', cache: 'Add Cache', spare: 'Add Hot Spare' };
  const modeHints: Record<string, React.ReactNode> = {
    extend: <>Expand your pool by adding a new vdev or attaching to an existing one (e.g. RAIDZ Expansion).</>,
    cache:  cacheType === 'l2arc'
      ? <>Adds one disk as an <strong>L2ARC read cache</strong> to accelerate read performance. Data is volatile and survives reboots.</>
      : <>Adds one disk as a <strong>ZIL/SLOG write log</strong> to accelerate synchronous writes and protect against power loss.</>,
    spare:  <>Adds a disk as a <strong>hot spare</strong> — ZFS will automatically use it to replace a failed drive (<code style={{ fontFamily: 'var(--font-mono)' }}>autoreplace</code> must be enabled). Only free disks (not in any pool) are shown.</>,
  };

  const cmdPreview = mode === 'cache'
    ? `zpool add ${poolName} ${cacheType === 'l2arc' ? 'cache' : 'log'} ${disk || '<disk>'}`
    : mode === 'spare'
      ? `zpool add ${poolName} spare ${disk || '<disk>'}`
      : expandMode === 'attach'
        ? `zpool attach -f ${poolName} ${targetForPreview} ${disk || '<disk>'}`
        : `zpool add -f ${poolName} ${disk || '<disk>'}`;

  const handleExpand = async () => {
    if (!ready) { setError('Select a disk to continue'); return; }
    // Block adding a disk that is already a member of this pool as a spare
    if (mode === 'spare') {
      const shortName = disk.replace(/^\/dev\//, '');
      if (poolDiskNames.has(shortName)) {
        setError(`${disk} is already a member of pool "${poolName}" and cannot be added as a hot spare. Choose a different disk.`);
        return;
      }
    }
    setExpanding(true); setError('');
    try {
      if (mode === 'cache') {
        const vdevType = cacheType === 'l2arc' ? 'cache' : 'log';
        await api.expandPool(poolName, [disk], vdevType, false);
      } else if (mode === 'spare') {
        await api.expandPool(poolName, [disk], 'spare', false);
      } else {
        const actualTarget = (expandMode === 'attach' && targetVdev) ? targetVdev : 'STRIPE_NEW';
        await api.expandPool(poolName, [disk], undefined, true, actualTarget);
      }
      onSuccess();
    }
    catch (err: any) { setError(err.message || 'Expand failed'); }
    finally { setExpanding(false); }
  };

  return (
    <div className="modal-overlay" style={S.modal.overlay} onClick={onClose}>
      <div className="modal-box" style={{ ...S.modal.box, maxWidth: 500, maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div>
            <h3 style={S.modal.title}>Expand Pool</h3>
            <p style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 3 }}>
              {mode === 'cache' ? 'zpool add cache' : mode === 'spare' ? 'zpool add spare' : expandMode === 'attach' ? 'zpool attach' : 'zpool add'} {poolName}
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}><X size={16} /></button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Mode selector */}
          <div>
            <label style={S.modal.label}>Operation</label>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['extend', 'cache', 'spare'] as const).map(m => (
                <button key={m} onClick={() => { setMode(m); setDisk(''); setError(''); setCacheType('l2arc'); }} style={{
                  flex: 1, padding: '8px 6px', fontSize: 12, fontFamily: 'var(--font-ui)',
                  background: mode === m ? 'var(--accent)' : 'var(--bg-elevated)',
                  color: mode === m ? '#fff' : 'var(--text-secondary)',
                  border: `1px solid ${mode === m ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius)', cursor: 'pointer', transition: 'all 0.12s',
                }}>
                  {modeLabels[m]}
                </button>
              ))}
            </div>
          </div>

          {/* Cache type selection (L2ARC vs ZIL/SLOG) */}
          {mode === 'cache' && (
            <div>
              <label style={S.modal.label}>Cache Type</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {([
                  { key: 'l2arc', label: 'L2ARC', sub: 'Read Cache', desc: 'zpool add … cache /dev/[disk]' },
                  { key: 'slog',  label: 'ZIL/SLOG', sub: 'Write Log', desc: 'zpool add … log /dev/[disk]' },
                ] as const).map(opt => (
                  <button
                    key={opt.key}
                    onClick={() => setCacheType(opt.key)}
                    style={{
                      flex: 1, padding: '10px 12px', borderRadius: 'var(--radius)', cursor: 'pointer', textAlign: 'left',
                      background: cacheType === opt.key ? 'var(--accent-dim)' : 'var(--bg-elevated)',
                      border: `1px solid ${cacheType === opt.key ? 'var(--accent-mid)' : 'var(--border)'}`,
                      transition: 'all 0.12s',
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 700, color: cacheType === opt.key ? 'var(--accent)' : 'var(--text-primary)', fontFamily: 'var(--font-ui)' }}>{opt.label}</div>
                    <div style={{ fontSize: 11, color: cacheType === opt.key ? 'var(--accent)' : 'var(--text-muted)', fontFamily: 'var(--font-ui)', marginTop: 2 }}>{opt.sub}</div>
                    <div style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 4 }}>{opt.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Hint */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 'var(--radius)' }}>
            <AlertTriangle size={13} style={{ color: 'var(--info)', marginTop: 1, flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-ui)', lineHeight: 1.5 }}>
              {modeHints[mode]}
            </span>
          </div>

          {mode === 'extend' && dataVdevs.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label style={S.modal.label}>Extend Strategy for {poolName}</label>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 14px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="radio" name="expandMode" checked={expandMode === 'new'} onChange={() => setExpandMode('new')} style={{ margin: 0 }} />
                  <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>Create new VDEV</span>
                </label>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', paddingLeft: 21 }}>
                  Adds the disk as a new standalone Stripe VDEV using <code style={{ fontFamily: 'var(--font-mono)' }}>zpool add</code>.
                </div>
              </div>

              {attachSupported && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 14px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input type="radio" name="expandMode" checked={expandMode === 'attach'} onChange={() => { setExpandMode('attach'); if (!targetVdev) setTargetVdev(dataVdevs[0]?.name || dataVdevs[0]?.type || ''); }} style={{ margin: 0 }} />
                    <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>Expand existing VDEV (Attach)</span>
                  </label>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', paddingLeft: 21 }}>
                    Expands capacity of an existing RAIDZ VDEV by attaching a disk using <code style={{ fontFamily: 'var(--font-mono)' }}>zpool attach</code>.
                  </div>
                  {raidzEnabled === false && (
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, paddingLeft: 21, marginTop: 2 }}>
                      <AlertTriangle size={11} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 1 }} />
                      <span style={{ fontSize: 11, color: 'var(--warning)', lineHeight: 1.4 }}>
                        RAIDZ Expansion is not enabled on this pool — attaching to a RAIDZ vdev will fail. Enable it via <strong>Pool Features</strong>.
                      </span>
                    </div>
                  )}
                  {expandMode === 'attach' && (
                    <div style={{ paddingLeft: 21 }}>
                      <select style={{ ...S.modal.select, width: '100%' }} value={targetVdev} onChange={e => setTargetVdev(e.target.value)}>
                        {dataVdevs.map(v => (
                          <option key={v.name || v.type} value={v.name || v.type || ''}>{v.name || v.type} ({v.type})</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <label style={S.modal.label}>Select disk</label>
          <InlineDiskPicker selected={disk} onSelect={setDisk} onlyFree={true} />

          {/* Warn when selected disk is already in the pool (spare mode only) */}
          {mode === 'spare' && disk && poolDiskNames.has(disk.replace(/^\/dev\//, '')) && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 14px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 'var(--radius)' }}>
              <AlertTriangle size={13} style={{ color: 'var(--danger)', flexShrink: 0, marginTop: 1 }} />
              <span style={{ fontSize: 12, color: 'var(--danger)', lineHeight: 1.5 }}>
                <strong>{disk}</strong> is already a member of this pool. Select a different disk to use as a hot spare.
              </span>
            </div>
          )}

          <div style={{ background: 'var(--bg-elevated)', borderRadius: 'var(--radius)', padding: '8px 12px', border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Command preview</div>
            <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--info)', wordBreak: 'break-all' }}>{cmdPreview}</code>
          </div>

          {error && <div style={{ padding: '10px 14px', background: 'var(--danger-dim)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 'var(--radius)', fontSize: 12, color: 'var(--danger)' }}>{error}</div>}

          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-secondary" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={handleExpand} disabled={expanding || !ready}>
              {expanding ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Expand size={14} />}
              {expanding ? 'Adding…' : modeLabels[mode]}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Pool Features Modal ──────────────────────────────────────────────────────── */
type FeatureEntry = { name: string; property: string; value: string; enabled: boolean };

const FEATURE_DESCRIPTIONS: Record<string, string> = {
  async_destroy:          'Destroy filesystems asynchronously in the background, reducing impact on I/O.',
  empty_bpobj:            'Optimized representation of empty block pointer lists, reducing space overhead.',
  lz4_compress:           'Enables the LZ4 compression algorithm — fast and efficient for most workloads.',
  multi_vdev_crash_dump:  'Support crash dumps on pools with multiple top-level vdevs.',
  spacemap_histogram:     'Stores a histogram of free space in each spacemap for faster allocation decisions.',
  enabled_txg:            'Tracks the transaction group in which each feature was first enabled.',
  hole_birth:             'Records the transaction group in which a hole was created, enabling efficient incremental send.',
  extensible_dataset:     'Enables per-dataset feature flags and extensible metadata on datasets.',
  embedded_data:          'Stores small block data directly inside block pointers, saving space for tiny files.',
  bookmarks:              'Allows creating lightweight bookmarks of snapshot points without using snapshot space.',
  filesystem_limits:      'Enforces limits on the number of filesystems and snapshots per dataset.',
  large_blocks:           'Supports record sizes larger than 128 KB (up to 1 MB) for sequential workloads.',
  large_dnode:            'Allows variable-length dnodes, enabling more bonus space for metadata.',
  sha512:                 'Enables SHA-512/256 and Skein checksum algorithms as alternatives to SHA-256.',
  skein:                  'Enables the Skein checksum algorithm for data integrity verification.',
  edonr:                  'Enables the Edon-R checksum algorithm — faster than SHA-256 for checksum-only use.',
  userobj_accounting:     'Tracks per-user and per-group object counts alongside space accounting.',
  encryption:             'Enables native ZFS dataset encryption with per-dataset keys.',
  project_quota:          'Allows setting space and object quotas on project IDs within a dataset.',
  device_removal:         'Allows removing top-level vdevs (mirrors, stripes) from a pool.',
  obsolete_counts:        'Tracks counts of obsolete space mappings after device removal.',
  zpool_checkpoint:       'Allows saving and rewinding to a pool checkpoint — a full pool snapshot.',
  spacemap_v2:            'New spacemap format that scales better for large, fragmented pools.',
  allocation_classes:     'Enables separate allocation classes (e.g. special vdevs for metadata).',
  resilver_defer:         'Defers a new resilver if one is already running, reducing redundant work.',
  bookmark_v2:            'Extended bookmarks that store more information, including redaction lists.',
  redaction_bookmarks:    'Bookmarks used to track redacted send streams for privacy-preserving replication.',
  redacted_datasets:      'Datasets produced by redacted send — contain holes where data was redacted.',
  bookmark_written:       'Adds written space tracking to bookmarks for delta calculations.',
  log_spacemap:           'Uses a dedicated log for spacemap updates, greatly improving import time on large pools.',
  livelist:               'Tracks live block references during deletion, accelerating dataset destroy.',
  device_rebuild:         'Enables sequential device rebuild for mirror and dRAID vdevs — faster than traditional resilver.',
  zstd_compress:          'Enables the Zstandard compression algorithm — higher ratios than LZ4 with tunable levels.',
  draid:                  'Distributed spare RAID — distributes spare capacity across all drives for faster rebuild.',
  zilsaxattr:             'Stores extended attributes (xattrs) in the ZIL for atomic xattr+data writes.',
  head_errlog:            'Maintains a per-head-dataset error log rather than a single pool-wide log.',
  blake3:                 'Enables the BLAKE3 checksum algorithm — very fast hardware-accelerated integrity checks.',
  block_cloning:          'Allows copy-on-write block cloning (reflink) — instant zero-space file copies.',
  vdev_zaps_v2:           'Extended ZAP (ZFS Attribute Processor) objects on vdevs for more per-vdev metadata.',
  raidz_expansion:        'Allows adding disks to an existing RAIDZ vdev to expand capacity online.',
  fast_dedup:             'New deduplication engine with in-memory hash table — significantly faster than classic dedup.',
  longname:               'Supports filenames longer than 255 bytes (up to 1023 bytes) in UTF-8.',
};

function FeatureToggle({ isOn, locked, pending, onClick }: { isOn: boolean; locked: boolean; pending: boolean; onClick: () => void }) {
  const trackColor = locked ? 'var(--success)' : pending ? 'var(--warning)' : isOn ? 'var(--accent)' : 'rgba(255,255,255,0.08)';
  const borderColor = locked ? 'rgba(34,197,94,0.5)' : pending ? 'rgba(245,158,11,0.5)' : isOn ? 'rgba(99,179,237,0.5)' : 'var(--border)';
  return (
    <button
      disabled={locked}
      onClick={onClick}
      style={{
        width: 36, height: 20, borderRadius: 10, flexShrink: 0,
        background: trackColor, border: `1px solid ${borderColor}`,
        position: 'relative', cursor: locked ? 'default' : 'pointer',
        transition: 'all 0.18s', opacity: locked ? 0.5 : 1, padding: 0,
      }}
    >
      <div style={{
        position: 'absolute', top: 2, left: isOn ? 16 : 2,
        width: 14, height: 14, borderRadius: 7,
        background: (locked || isOn) ? '#fff' : 'rgba(255,255,255,0.35)',
        transition: 'left 0.18s ease', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
      }} />
    </button>
  );
}

function FeaturesModal({ poolName, onClose }: { poolName: string; onClose: () => void }) {
  const { notify } = useNotifications();
  const [features,     setFeatures]     = useState<FeatureEntry[]>([]);
  const [loading,      setLoading]      = useState(true);
  // Map<featureName, desiredEnabled> — staged but not yet saved
  const [staged,       setStaged]       = useState<Map<string, boolean>>(new Map());
  const [confirmSave,  setConfirmSave]  = useState(false);
  const [saving,       setSaving]       = useState(false);
  const [hovered,      setHovered]      = useState<FeatureEntry | null>(null);
  const [featureSearch, setFeatureSearch] = useState('');

  useEffect(() => {
    api.getPoolFeatures(poolName)
      .then(res => setFeatures(res.features || []))
      .catch(() => setFeatures([]))
      .finally(() => setLoading(false));
  }, [poolName]);

  const handleToggle = (f: FeatureEntry) => {
    if (f.value === 'active') return;
    const currentOn   = f.value === 'active' || f.value === 'enabled';
    const effectiveOn = staged.has(f.name) ? staged.get(f.name)! : currentOn;
    const wantOn      = !effectiveOn; // flip the *displayed* state, not the server state
    setStaged(prev => {
      const next = new Map(prev);
      // Back to server state → remove from staged (no change needed)
      if (wantOn === currentOn) next.delete(f.name);
      else                      next.set(f.name, wantOn);
      return next;
    });
  };

  const handleSaveAll = async () => {
    setConfirmSave(false);
    setSaving(true);
    const entries = [...staged.entries()];
    const errors: string[] = [];
    for (const [name, enable] of entries) {
      try {
        await api.togglePoolFeature(poolName, name, enable);
        const newValue = enable ? 'enabled' : 'disabled';
        setFeatures(prev => prev.map(f =>
          f.name === name ? { ...f, value: newValue, enabled: enable } : f
        ));
      } catch (err: any) {
        errors.push(`${name}: ${err.message || 'failed'}`);
      }
    }
    setStaged(new Map());
    setSaving(false);
    if (errors.length === 0) {
      notify({ type: 'success', title: 'Features Saved', message: `${entries.length} change${entries.length > 1 ? 's' : ''} applied to "${poolName}"` });
    } else {
      notify({ type: 'error', title: `${errors.length} change(s) failed`, message: errors.join(' · ') });
    }
  };

  const statusColor = (v: string) => v === 'active' ? 'var(--success)' : v === 'enabled' ? 'var(--accent)' : 'var(--text-muted)';

  const fq = featureSearch.trim().toLowerCase();
  const filteredFeatures = fq ? features.filter(f => f.name.toLowerCase().includes(fq)) : features;
  const active   = filteredFeatures.filter(f => f.value === 'active').sort((a,b) => a.name.localeCompare(b.name));
  const enabled  = filteredFeatures.filter(f => f.value === 'enabled').sort((a,b) => a.name.localeCompare(b.name));
  const disabled = filteredFeatures.filter(f => f.value === 'disabled').sort((a,b) => a.name.localeCompare(b.name));

  const renderSection = (label: string, items: FeatureEntry[], dot: string) => {
    if (items.length === 0) return null;
    return (
      <div style={{ marginBottom: 4 }}>
        <div style={{ padding: '8px 14px 4px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: dot, display: 'inline-block', flexShrink: 0 }} />
          <span style={{ fontSize: 9, fontWeight: 700, color: dot, fontFamily: 'var(--font-ui)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{label}</span>
          <span style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-ui)', marginLeft: 2 }}>{items.length}</span>
        </div>
        {items.map(f => {
          const isActive  = f.value === 'active';
          const currentOn = f.value === 'active' || f.value === 'enabled';
          const hasPending = staged.has(f.name);
          const effectiveOn = hasPending ? staged.get(f.name)! : currentOn;
          const isHov = hovered?.name === f.name;
          return (
            <div key={f.name}
              onMouseEnter={() => setHovered(f)}
              onMouseLeave={() => setHovered(h => h?.name === f.name ? null : h)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '7px 14px',
                background: isHov ? 'rgba(255,255,255,0.04)' : hasPending ? 'rgba(245,158,11,0.04)' : 'transparent',
                borderLeft: `2px solid ${hasPending ? 'rgba(245,158,11,0.5)' : isHov ? dot : 'transparent'}`,
                cursor: 'default', transition: 'background 0.12s, border-color 0.12s',
                opacity: saving ? 0.5 : 1,
              }}
            >
              <span style={{
                width: 5, height: 5, borderRadius: '50%', display: 'inline-block', flexShrink: 0,
                background: hasPending ? 'var(--warning)' : dot,
                opacity: (isActive || hasPending) ? 1 : 0.45,
              }} />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: isHov ? 'var(--text-primary)' : 'var(--text-secondary)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', transition: 'color 0.12s' }}>
                {f.name}
              </span>
              {hasPending && (
                <span style={{ fontSize: 9, color: 'var(--warning)', fontFamily: 'var(--font-ui)', flexShrink: 0 }}>
                  {effectiveOn ? '→ on' : '→ off'}
                </span>
              )}
              <FeatureToggle isOn={effectiveOn} locked={isActive} pending={hasPending} onClick={() => handleToggle(f)} />
            </div>
          );
        })}
      </div>
    );
  };

  const desc      = hovered ? FEATURE_DESCRIPTIONS[hovered.name] : null;
  const hovStaged = hovered ? staged.get(hovered.name) : undefined;
  const hovCurrentOn = hovered ? (hovered.value === 'active' || hovered.value === 'enabled') : false;
  const hovEffectiveOn = hovStaged !== undefined ? hovStaged : hovCurrentOn;
  const stagedCount = staged.size;

  // staged changes for the confirm dialog
  const stagedList = [...staged.entries()].map(([name, enable]) => {
    const f = features.find(x => x.name === name);
    const fromVal = f?.value ?? '?';
    const toVal   = enable ? 'enabled' : 'disabled';
    const isPermanent = enable && fromVal === 'disabled';
    return { name, enable, fromVal, toVal, isPermanent };
  });
  const hasPermChanges = stagedList.some(s => s.isPermanent);

  return (
    <div className="modal-overlay" style={S.modal.overlay} onClick={() => { if (!confirmSave) onClose(); }}>
      <div className="modal-box" style={{ ...S.modal.box, maxWidth: 720, padding: 0, overflow: 'hidden' }} onClick={e => e.stopPropagation()}>

        {/* ── Header ───────────────────────────────────────────────────────── */}
        <div style={{ padding: '20px 24px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 32, height: 32, borderRadius: 'var(--radius)', background: 'rgba(99,179,237,0.12)', border: '1px solid rgba(99,179,237,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Layers size={15} style={{ color: 'var(--accent)' }} />
              </div>
              <div>
                <h3 style={{ ...S.modal.title, margin: 0 }}>Pool Features</h3>
                <p style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                  {poolName} &nbsp;·&nbsp;
                  <span style={{ color: 'var(--success)' }}>{active.length} active</span>
                  {enabled.length > 0 && <>&nbsp;·&nbsp;<span style={{ color: 'var(--accent)' }}>{enabled.length} enabled</span></>}
                  {disabled.length > 0 && <>&nbsp;·&nbsp;{disabled.length} disabled</>}
                  {stagedCount > 0 && <>&nbsp;·&nbsp;<span style={{ color: 'var(--warning)' }}>{stagedCount} pending</span></>}
                </p>
              </div>
            </div>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4, flexShrink: 0 }}><X size={16} /></button>
          </div>

          {/* General info callout */}
          <div style={{ padding: '10px 14px', background: 'rgba(99,179,237,0.06)', border: '1px solid rgba(99,179,237,0.18)', borderRadius: 'var(--radius)', display: 'flex', gap: 10, marginBottom: 12 }}>
            <Info size={13} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 1 }} />
            <p style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
              ZFS features are <strong style={{ color: 'var(--text-primary)' }}>permanent on-disk format extensions</strong>. Once a feature becomes <span style={{ color: 'var(--success)' }}>active</span> (data uses it), it cannot be removed. Toggle as many features as you want, then click <strong>Save Changes</strong>.
            </p>
          </div>

          {/* Feature search */}
          <div style={{ position: 'relative' }}>
            <Search size={12} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
            <input
              type="text"
              placeholder="Search features…"
              value={featureSearch}
              onChange={e => setFeatureSearch(e.target.value)}
              style={{
                width: '100%', boxSizing: 'border-box',
                paddingLeft: 28, paddingRight: 10, paddingTop: 6, paddingBottom: 6,
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius)', color: 'var(--text-primary)',
                fontSize: 12, fontFamily: 'var(--font-mono)', outline: 'none',
              }}
            />
          </div>
        </div>

        {/* ── Confirm save dialog ───────────────────────────────────────────── */}
        {confirmSave && (
          <div style={{ margin: '0 24px 14px', padding: '14px', background: hasPermChanges ? 'rgba(239,68,68,0.07)' : 'rgba(245,158,11,0.07)', border: `1px solid ${hasPermChanges ? 'rgba(239,68,68,0.25)' : 'rgba(245,158,11,0.25)'}`, borderRadius: 'var(--radius)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <AlertTriangle size={13} style={{ color: hasPermChanges ? 'var(--danger)' : 'var(--warning)', flexShrink: 0 }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: hasPermChanges ? 'var(--danger)' : 'var(--warning)' }}>
                {hasPermChanges ? 'Permanent changes included' : 'Confirm changes'}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
              {stagedList.map(s => (
                <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                  <span style={{ width: 4, height: 4, borderRadius: '50%', background: s.enable ? 'var(--accent)' : 'var(--text-muted)', display: 'inline-block', flexShrink: 0 }} />
                  <span style={{ color: 'var(--text-primary)', minWidth: 180 }}>{s.name}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{s.fromVal} → {s.toVal}</span>
                  {s.isPermanent && <span style={{ fontSize: 9, color: 'var(--danger)', fontFamily: 'var(--font-ui)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>permanent</span>}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary" style={{ flex: 1, fontSize: 11 }} onClick={() => setConfirmSave(false)}>Cancel</button>
              <button className="btn btn-primary" style={{ flex: 1, fontSize: 11 }} onClick={handleSaveAll}>
                Apply {stagedCount} Change{stagedCount > 1 ? 's' : ''}
              </button>
            </div>
          </div>
        )}

        {/* ── Body: two-column ─────────────────────────────────────────────── */}
        <div style={{ display: 'flex', borderTop: '1px solid var(--border)', height: 380 }}>

          {/* Left: scrollable feature list */}
          <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', height: '100%', borderRight: '1px solid var(--border)', paddingTop: 6, paddingBottom: 10 }} className="no-scrollbar">
            {loading ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '48px 0', justifyContent: 'center' }}>
                <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', color: 'var(--text-muted)' }} />
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</span>
              </div>
            ) : features.length === 0 ? (
              <div style={{ padding: '24px', textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>No features returned.</div>
            ) : (
              <>
                {renderSection('Active', active,   'var(--success)')}
                {renderSection('Enabled', enabled,  'var(--accent)')}
                {renderSection('Disabled', disabled, 'var(--text-muted)')}
              </>
            )}
          </div>

          {/* Right: description panel */}
          <div style={{ width: 260, flexShrink: 0, padding: '20px', display: 'flex', flexDirection: 'column', background: 'var(--bg-elevated)', height: '100%', overflowY: 'auto' }}>
            {hovered ? (
              <>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', wordBreak: 'break-all', lineHeight: 1.4, marginBottom: 8 }}>
                    {hovered.name}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5,
                      fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 999,
                      color: statusColor(hovered.value),
                      background: hovered.value === 'active' ? 'rgba(34,197,94,0.12)' : hovered.value === 'enabled' ? 'rgba(99,179,237,0.12)' : 'rgba(255,255,255,0.06)',
                      border: `1px solid ${hovered.value === 'active' ? 'rgba(34,197,94,0.3)' : hovered.value === 'enabled' ? 'rgba(99,179,237,0.3)' : 'var(--border)'}`,
                      fontFamily: 'var(--font-ui)', textTransform: 'uppercase', letterSpacing: '0.07em',
                    }}>
                      <span style={{ width: 5, height: 5, borderRadius: '50%', background: statusColor(hovered.value), display: 'inline-block' }} />
                      {hovered.value}
                    </span>
                    {hovStaged !== undefined && (
                      <span style={{ fontSize: 10, color: 'var(--warning)', fontFamily: 'var(--font-ui)' }}>
                        → {hovEffectiveOn ? 'enabled' : 'disabled'}
                      </span>
                    )}
                  </div>
                </div>

                <div style={{ flex: 1 }}>
                  {desc
                    ? <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.65, margin: 0 }}>{desc}</p>
                    : <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.65, margin: 0, fontStyle: 'italic' }}>No description available.</p>
                  }
                </div>

                <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)', fontSize: 10, fontFamily: 'var(--font-ui)', lineHeight: 1.5 }}>
                  {hovered.value === 'active'   && <span style={{ color: 'var(--success)' }}>In use — toggle is locked.</span>}
                  {hovered.value === 'enabled'  && <span style={{ color: 'var(--accent)' }}>Not yet active — can still be disabled.</span>}
                  {hovered.value === 'disabled' && <span style={{ color: 'var(--text-muted)' }}>Enabling is permanent once data uses it.</span>}
                </div>
              </>
            ) : (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, opacity: 0.4 }}>
                <Layers size={28} style={{ color: 'var(--text-muted)' }} />
                <p style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.5, margin: 0, fontFamily: 'var(--font-ui)' }}>
                  Hover a feature<br />to see its description
                </p>
              </div>
            )}
          </div>
        </div>

        {/* ── Footer ───────────────────────────────────────────────────────── */}
        <div style={{ padding: '12px 24px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', gap: 14, fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-ui)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', display: 'inline-block' }} /> active
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', display: 'inline-block' }} /> enabled
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--border)', display: 'inline-block' }} /> disabled
            </span>
            {stagedCount > 0 && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--warning)', display: 'inline-block' }} /> pending
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            {stagedCount > 0 && (
              <button className="btn btn-secondary" style={{ fontSize: 11 }} onClick={() => setStaged(new Map())}>
                Reset
              </button>
            )}
            <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={onClose}>Close</button>
            <button
              className="btn btn-primary"
              style={{ fontSize: 12, opacity: stagedCount === 0 ? 0.4 : 1 }}
              disabled={stagedCount === 0 || saving}
              onClick={() => setConfirmSave(true)}
            >
              {saving
                ? <><Loader2 size={12} style={{ animation: 'spin 1s linear infinite', display: 'inline', marginRight: 6 }} />Saving…</>
                : stagedCount > 0 ? `Save ${stagedCount} Change${stagedCount > 1 ? 's' : ''}` : 'Save Changes'
              }
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Create Pool Modal ────────────────────────────────────────────────────────── */
function CreatePoolModal({ onClose, onSuccess, usedDisks = new Set<string>() }: { onClose: () => void; onSuccess: (name: string) => void; usedDisks?: Set<string> }) {
  const [poolName, setPoolName] = useState('');
  const [vdevType, setVdevType] = useState<VdevType>('mirror');
  const [devices, setDevices]   = useState<string[]>(['', '']);
  const [ashift, setAshift]     = useState('12');
  const [force, setForce]       = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError]       = useState('');
  const [showPicker, setShowPicker] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<number | null>(null);

  const info        = VDEV_INFO[vdevType];
  const validDev    = devices.filter(d => d.trim());
  const minMet      = validDev.length >= info.min;

  const addDevice    = () => setDevices(d => [...d, '']);
  const removeDevice = (i: number) => setDevices(d => d.filter((_, j) => j !== i));
  const setDevice    = (i: number, val: string) => setDevices(d => d.map((v, j) => j === i ? val : v));

  const openPickerFor = (idx: number) => { setPickerTarget(idx); setShowPicker(true); };
  const handlePickerSelect = (path: string) => {
    if (pickerTarget !== null) setDevice(pickerTarget, path);
    else setDevices(d => [...d, path]);
  };

  const buildVdevs   = (): string[] => vdevType === 'stripe' ? validDev : [vdevType, ...validDev];
  const buildOptions = (): string[] => {
    const opts: string[] = [];
    if (ashift && ashift !== '0') opts.push('-o', `ashift=${ashift}`);
    if (force) opts.push('-f');
    return opts;
  };

  const preview = ['zpool create', ...buildOptions(), poolName || '<pool-name>', ...buildVdevs().map(d => d || '<device>')].join(' ');

  const handleCreate = async () => {
    setError('');
    if (!poolName.trim()) { setError('Pool name is required'); return; }
    if (validDev.length < info.min) { setError(`${info.label} requires at least ${info.min} device(s)`); return; }
    setCreating(true);
    try { await api.createPool(poolName.trim(), buildVdevs(), buildOptions()); onSuccess(poolName.trim()); }
    catch (err: any) { setError(err.message || 'Pool creation failed'); }
    finally { setCreating(false); }
  };

  return (
    <>
      {showPicker && (
        <DiskPicker
          onSelect={path => { handlePickerSelect(path); setShowPicker(false); }}
          onClose={() => setShowPicker(false)}
          selected={pickerTarget !== null ? devices[pickerTarget] : undefined}
          addedDisks={devices.filter((d, idx) => d.trim() && (pickerTarget === null || idx !== pickerTarget))}
          onlyFree={true}
        />
      )}
      <div className="modal-overlay" style={S.modal.overlay} onClick={onClose}>
        <div className="modal-box" style={{ ...S.modal.box, maxWidth: 540, maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
            <h3 style={S.modal.title}>Create ZFS Pool</h3>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}><X size={16} /></button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div>
              <label style={S.modal.label}>Pool Name</label>
              <input style={S.modal.input} type="text" placeholder="e.g. tank, storage, data" value={poolName} onChange={e => setPoolName(e.target.value.replace(/[^a-zA-Z0-9_\-:.]/g, ''))} />
            </div>

            <div>
              <label style={S.modal.label}>VDEV Type</label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
                {(Object.keys(VDEV_INFO) as VdevType[]).map(t => (
                  <button key={t} onClick={() => { setVdevType(t); const min = VDEV_INFO[t].min; setDevices(d => d.length < min ? [...d, ...Array(min - d.length).fill('')] : d); }} style={{
                    padding: '8px 4px', borderRadius: 'var(--radius)', fontSize: 10, fontWeight: 700,
                    textTransform: 'uppercase', letterSpacing: '0.05em', cursor: 'pointer', transition: 'all 0.12s',
                    border: `1px solid ${vdevType === t ? VDEV_INFO[t].color + '44' : 'var(--border)'}`,
                    background: vdevType === t ? VDEV_INFO[t].color + '18' : 'var(--bg-elevated)',
                    color: vdevType === t ? VDEV_INFO[t].color : 'var(--text-muted)',
                  }}>{VDEV_INFO[t].label}</button>
                ))}
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>{info.desc}</p>
            </div>

            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <label style={{ ...S.modal.label, marginBottom: 0 }}>Devices / Paths</label>
                <button onClick={() => { setPickerTarget(null); setShowPicker(true); }} style={{ fontSize: 11, color: 'var(--info)', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <HardDrive size={11} /> Browse Disks
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {devices.map((dev, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6 }}>
                    <input style={{ ...S.modal.input, flex: 1 }} type="text" placeholder="/dev/sdX" value={dev} onChange={e => setDevice(i, e.target.value)} />
                    <button className="btn btn-secondary" onClick={() => openPickerFor(i)} title="Browse"><HardDrive size={12} /></button>
                    {devices.length > info.min && (
                      <button className="btn btn-danger" onClick={() => removeDevice(i)} title="Remove"><Trash2 size={12} /></button>
                    )}
                  </div>
                ))}
              </div>
              <button onClick={addDevice} style={{ marginTop: 8, background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--info)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Plus size={12} /> Add device
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={S.modal.label}>Ashift</label>
                <select style={S.modal.select} value={ashift} onChange={e => setAshift(e.target.value)}>
                  <option value="9">9 — 512B (HDD legacy)</option>
                  <option value="12">12 — 4K (SSD/modern)</option>
                  <option value="13">13 — 8K</option>
                  <option value="0">Auto-detect</option>
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                  <div onClick={() => setForce(v => !v)} style={{ width: 36, height: 20, borderRadius: 10, background: force ? 'var(--warning)' : 'var(--bg-elevated)', border: '1px solid var(--border)', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
                    <div style={{ position: 'absolute', top: 2, left: force ? 17 : 2, width: 14, height: 14, borderRadius: 7, background: '#fff', transition: 'left 0.2s' }} />
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Force (-f)</span>
                </label>
              </div>
            </div>

            <div style={{ background: 'var(--bg-elevated)', borderRadius: 'var(--radius)', padding: '10px 14px', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>Command preview</div>
              <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--info)', wordBreak: 'break-all' }}>{preview}</code>
            </div>

            {!minMet && validDev.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--warning)' }}>
                <AlertTriangle size={14} />
                <span style={{ fontSize: 12 }}>{info.label} needs at least {info.min} devices ({validDev.length} provided)</span>
              </div>
            )}

            {error && (
              <div style={{ padding: '10px 14px', background: 'var(--danger-dim)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 'var(--radius)', fontSize: 12, color: 'var(--danger)' }}>{error}</div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-secondary" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={handleCreate} disabled={creating || !poolName.trim() || !minMet}>
                {creating ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Database size={14} />}
                {creating ? 'Creating…' : 'Create Pool'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* ── Disk Row ─────────────────────────────────────────────────────────────────── */
function DiskRow({ disk, poolName, onReplace, onSmartClick }: {
  disk: { path: string; state: string; replacing_with?: string; via_spare?: boolean; being_replaced_by?: string };
  poolName: string;
  onReplace: (disk: string) => void;
  onSmartClick: (disk: string) => void;
}) {
  const [hov, setHov] = useState(false);
  const isReplacing = !!disk.replacing_with;
  const isOnline    = disk.state === 'ONLINE';
  const isFailed    = ['REMOVED', 'FAULTED', 'UNAVAIL', 'OFFLINE'].includes(disk.state);
  const isDegraded  = disk.state === 'DEGRADED';

  // Always show the actual disk state color — even when a spare is covering it
  const stateColor = isOnline  ? (isReplacing ? 'var(--info)' : 'var(--success)')
    : isFailed                 ? 'var(--danger)'
    : isDegraded               ? 'var(--warning)'
    : 'var(--danger)';

  // Show state + full replacement chain so the user always knows what's happening:
  //   via_spare=true, no being_replaced_by  → spare covering:   "removed → spare: sdh"
  //   via_spare=true, being_replaced_by=sda → spare + replace:  "degraded → spare: sdh → sda"
  //   via_spare=false                       → manual replace:   "replacing → sda"
  const rw  = (disk.replacing_with    || '').replace(/^\/dev\//, '');
  const rbr = (disk.being_replaced_by || '').replace(/^\/dev\//, '');
  const stateLabel = disk.replacing_with
    ? disk.via_spare
      ? rbr
        ? `${disk.state.toLowerCase()} → spare: ${rw} → ${rbr}` // spare + new disk resilvering
        : `${disk.state.toLowerCase()} → spare: ${rw}`           // spare covering
      : `replacing → ${rw}`                                       // manual replace
    : disk.state.toLowerCase();

  return (
    <div onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)} style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
      background: 'var(--bg-elevated)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', transition: 'border-color 0.12s',
      borderColor: hov ? 'rgba(255,255,255,0.12)' : 'var(--border)',
    }}>
      <HardDrive size={13} style={{ color: stateColor, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div title={disk.path || 'missing'} style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: disk.path ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontStyle: disk.path ? 'normal' : 'italic' }}>
          {disk.path ? disk.path.replace(/^\/dev\//, '') : '(missing)'}
        </div>
        <div style={{ fontSize: 9, color: stateColor, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 1 }}>{stateLabel}</div>
      </div>
      <div style={{ display: 'flex', gap: 4, opacity: hov ? 1 : 0, transition: 'opacity 0.12s' }}>
        <button title="SMART Data" onClick={() => onSmartClick(disk.path)} style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', color: 'var(--text-muted)' }}>
          <Cpu size={10} />
        </button>
        <button title="Replace Disk" onClick={() => onReplace(disk.path)} style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', color: 'var(--text-muted)' }}>
          <ArrowLeftRight size={10} />
        </button>
      </div>
    </div>
  );
}

/* ── Pool Settings Panel ─────────────────────────────────────────────────────── */

type PropDef = {
  name: string;
  label: string;
  desc: string;
  group: string;
  scope: 'pool' | 'dataset';
  type: 'toggle' | 'select' | 'text';
  options?: string[];
};

const POOL_PROP_DEFS: PropDef[] = [
  // Maintenance
  { name: 'autoreplace', label: 'Auto Replace', desc: 'Automatically substitute a hot spare when a drive fails', group: 'Maintenance', scope: 'pool', type: 'toggle' },
  { name: 'autotrim',    label: 'Auto Trim',    desc: 'Periodically send TRIM to SSD vdevs to reclaim free space', group: 'Maintenance', scope: 'pool', type: 'toggle' },
  { name: 'autoexpand',  label: 'Auto Expand',  desc: 'Grow the pool automatically after a larger replacement disk is added', group: 'Maintenance', scope: 'pool', type: 'toggle' },
  // Behavior
  { name: 'failmode', label: 'Fail Mode', desc: 'Action taken when pool cannot service an I/O request due to missing vdev', group: 'Behavior', scope: 'pool', type: 'select', options: ['wait', 'continue', 'panic'] },
  { name: 'comment',  label: 'Comment',   desc: 'Descriptive label stored in the pool configuration', group: 'Behavior', scope: 'pool', type: 'text' },
  // Compression & I/O
  { name: 'compression', label: 'Compression',    desc: 'Compression algorithm for new data blocks — lz4 is fastest with minimal overhead', group: 'Compression & I/O', scope: 'dataset', type: 'select', options: ['off', 'lz4', 'zstd', 'gzip', 'zle'] },
  { name: 'recordsize',  label: 'Record Size',    desc: 'Suggested block size; 128K suits large files, 4K–16K suits databases', group: 'Compression & I/O', scope: 'dataset', type: 'select', options: ['512', '1K', '2K', '4K', '8K', '16K', '32K', '64K', '128K', '1M'] },
  { name: 'xattr',       label: 'Extended Attrs', desc: 'Storage method for extended attributes — sa avoids extra znodes', group: 'Compression & I/O', scope: 'dataset', type: 'select', options: ['on', 'off', 'sa'] },
  { name: 'sync',        label: 'Sync Mode',      desc: 'Controls fsync() semantics — disabled improves throughput at risk of data loss on crash', group: 'Compression & I/O', scope: 'dataset', type: 'select', options: ['standard', 'always', 'disabled'] },
  // Access
  { name: 'atime',    label: 'Access Time',    desc: 'Update last-access timestamp on every read — disable for better read performance', group: 'Access', scope: 'dataset', type: 'toggle' },
  { name: 'relatime', label: 'Relative Atime', desc: 'Only update atime if older than mtime — a compromise between on and off', group: 'Access', scope: 'dataset', type: 'toggle' },
  { name: 'dedup',    label: 'Deduplication',  desc: 'Eliminate duplicate blocks — requires ~5 GB RAM per 1 TB of data', group: 'Access', scope: 'dataset', type: 'toggle' },
  // Quotas
  { name: 'quota',       label: 'Quota',       desc: 'Hard limit on total size including descendants and snapshots (e.g. 100G)', group: 'Quotas', scope: 'dataset', type: 'text' },
  { name: 'reservation', label: 'Reservation', desc: 'Minimum space guaranteed for this dataset from pool free (e.g. 10G)', group: 'Quotas', scope: 'dataset', type: 'text' },
  // Visibility
  { name: 'snapdir', label: 'Snapshot Dir', desc: 'Controls whether .zfs/snapshot is browsable by regular users', group: 'Visibility', scope: 'dataset', type: 'select', options: ['hidden', 'visible'] },
];

/* ── Scrub Schedule Settings UI ─────────────────────────────────────────────── */
function ScrubScheduleSettings({
  value, onChange
}: {
  value: string; onChange: (v: string) => void;
}) {
  const parsed = (() => {
    if (value === 'off') return { enabled: false, type: 'monthly', cron: '0 0 0 1 * * *' };
    if (!value || value === '-') return { enabled: true, type: 'monthly', cron: '0 0 0 1 * * *' };
    try { return JSON.parse(value); } catch { return { enabled: true, type: 'custom', cron: value }; }
  })();

  const enabled = parsed.enabled || false;
  const type = parsed.type || 'monthly';
  const cron = parsed.cron || '0 0 0 1 * * *';

  const update = (updates: any) => {
    onChange(JSON.stringify({ ...parsed, ...updates }));
  };

  const handleToggle = () => {
    if (enabled) {
      onChange('off');
    } else {
      update({ enabled: true });
    }
  };

  const setType = (newType: string) => {
    let newCron = cron;
    if (newType === 'daily') newCron = '0 0 0 * * * *';
    else if (newType === 'weekly') newCron = '0 0 0 * * 1 *';
    else if (newType === 'monthly') newCron = '0 0 0 1 * * *';
    update({ type: newType, cron: newCron });
  };

  return (
    <div style={{ paddingBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: enabled ? 'var(--accent)' : 'var(--text-primary)', fontFamily: 'var(--font-ui)' }}>
            Automated Scrub Schedule
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-ui)', marginTop: 2 }}>
            Periodically verify pool data integrity
          </div>
        </div>
        <button
          onClick={handleToggle}
          style={{
            width: 44, height: 22, borderRadius: 11, flexShrink: 0,
            background: enabled ? 'var(--success)' : 'var(--bg-elevated)',
            border: `1px solid ${enabled ? 'var(--success)' : 'var(--border)'}`,
            position: 'relative', cursor: 'pointer', transition: 'all 0.2s',
          }}
        >
          <div style={{
            position: 'absolute', top: 2,
            left: enabled ? 22 : 2,
            width: 16, height: 16, borderRadius: 8,
            background: '#fff', transition: 'left 0.2s',
          }} />
        </button>
      </div>

      <AnimatePresence>
        {enabled && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            style={{ overflow: 'hidden' }}
          >
            <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '12px 16px', marginTop: 8 }}>
              <label style={S.modal.label}>Frequency</label>
              <select style={{ ...S.modal.select, marginBottom: 12 }} value={type} onChange={e => setType(e.target.value)}>
                <option value="daily">Every Day</option>
                <option value="weekly">Every Week (Monday)</option>
                <option value="monthly">Every Month (1st)</option>
                <option value="custom">Custom (Cron Expression)</option>
              </select>

              {type === 'custom' && (
                <div>
                  <label style={S.modal.label}>Cron Expression (Sec Min Hour Day Month DoW Year)</label>
                  <input
                    type="text"
                    style={{ ...S.modal.input, fontFamily: 'var(--font-mono)' }}
                    value={cron}
                    onChange={e => update({ cron: e.target.value })}
                    placeholder="0 0 0 1 * * *"
                  />
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6, fontFamily: 'var(--font-mono)' }}>
                    Requires 6 or 7 fields (Seconds Minutes Hours DayOfMonth Month DayOfWeek [Year])
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── Settings Popout (slide-in from right) ──────────────────────────────────── */
function SettingsPopout({
  poolName,
  onClose,
  onSaved,
}: {
  poolName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { notify } = useNotifications();
  const [visible,           setVisible]           = useState(false);
  const [loading,           setLoading]           = useState(true);
  const [saving,            setSaving]            = useState(false);
  const [props,             setProps]             = useState<Record<string, string>>({});
  const [edits,             setEdits]             = useState<Record<string, string>>({});
  const [error,             setError]             = useState<string | null>(null);
  const [showDestroyDialog, setShowDestroyDialog] = useState(false);
  const [destroyInput,      setDestroyInput]      = useState('');
  const [destroying,        setDestroying]        = useState(false);

  useEffect(() => { requestAnimationFrame(() => setVisible(true)); }, []);

  const close = () => {
    setVisible(false);
    setTimeout(onClose, 310);
  };

  const load = () => {
    setLoading(true);
    setError(null);
    api.getPoolSettings(poolName).then(settingsRes => {
      const map: Record<string, string> = {};
      for (const p of [...settingsRes.pool_props, ...settingsRes.dataset_props]) map[p.name] = p.value;
      setProps(map);
      setEdits({ ...map });
    }).catch(err => {
      setError(err.message || 'Failed to load settings');
    }).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [poolName]);

  const pendingCount = Object.entries(edits).filter(([k, v]) => v !== (props[k] ?? '')).length;

  const handleSave = async () => {
    const changed = Object.entries(edits).filter(([k, v]) => v !== (props[k] ?? ''));
    if (changed.length === 0) { close(); return; }
    setSaving(true);
    try {
      for (const [k, v] of changed) {
        // Scrub schedule has no POOL_PROP_DEFS entry (rendered separately) —
        // without this case the PUT was never sent and the user's schedule was lost.
        if (k === 'zfsmanager:scrub_schedule') {
          await api.setPoolSetting(poolName, 'dataset', k, v);
          continue;
        }
        const def = POOL_PROP_DEFS.find(d => d.name === k);
        if (def) await api.setPoolSetting(poolName, def.scope, k, v);
      }
      onSaved();
      close();
    } catch (err: any) {
      notify({ type: 'error', title: 'Save Failed', message: err.message || 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const poolPropGroups    = Array.from(new Map(POOL_PROP_DEFS.filter(d => d.scope === 'pool').map(d => [d.group, d.group])).keys());
  const datasetPropGroups = Array.from(new Map(POOL_PROP_DEFS.filter(d => d.scope === 'dataset').map(d => [d.group, d.group])).keys());

  const sectionHeader = (title: string) => (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      marginTop: 20, marginBottom: 2, paddingBottom: 8,
      borderBottom: '1px solid var(--border)',
    }}>
      <span style={{
        fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
        color: 'var(--text-muted)', fontFamily: 'var(--font-ui)',
      }}>{title}</span>
    </div>
  );

  return (
    <>
      {/* Dark overlay */}
      <div
        onClick={close}
        style={{
          position: 'fixed', inset: 0, zIndex: 400,
          background: 'rgba(0,0,0,0.4)',
          opacity: visible ? 1 : 0,
          transition: 'opacity 300ms ease',
        }}
      />

      {/* Slide-in panel */}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 401,
        width: 400, maxWidth: '100vw',
        background: 'var(--bg-surface)',
        borderLeft: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
        transform: visible ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 300ms ease',
        boxShadow: '-8px 0 40px rgba(0,0,0,0.5)',
      }}>

        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: '1px solid var(--border)', flexShrink: 0,
        }}>
          <div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
              {poolName}
            </div>
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              Pool Settings
            </div>
          </div>
          <button
            onClick={close}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4, display: 'flex', alignItems: 'center' }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Scrollable body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px' }} className="no-scrollbar">
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 20 }}>
              {[48, 48, 48, 48, 48, 48, 48].map((h, i) => (
                <div key={i} className="skeleton" style={{ height: h, borderRadius: 'var(--radius)' }} />
              ))}
            </div>
          ) : error ? (
            <div style={{ paddingTop: 32, textAlign: 'center' }}>
              <div style={{ fontSize: 13, color: 'var(--danger)', fontFamily: 'var(--font-ui)', marginBottom: 16 }}>{error}</div>
              <button className="btn btn-secondary" onClick={load}>Retry</button>
            </div>
          ) : (
            <>
              <div style={{ paddingTop: 16, paddingBottom: 4 }}>
                {sectionHeader('Scrub Schedule')}
                <div style={{ marginTop: 12 }}>
                  <ScrubScheduleSettings
                    value={edits['zfsmanager:scrub_schedule'] ?? props['zfsmanager:scrub_schedule'] ?? 'off'}
                    onChange={v => setEdits(e => ({ ...e, 'zfsmanager:scrub_schedule': v }))}
                  />
                </div>
              </div>
              {/* Pool Property Groups */}
              <div style={{ paddingTop: 8 }}>
                {poolPropGroups.map(group => (
                  <div key={group}>
                    {sectionHeader(group)}
                    {POOL_PROP_DEFS.filter(d => d.scope === 'pool' && d.group === group).map(def => (
                      <PopoutPropRow
                        key={def.name}
                        def={def}
                        value={edits[def.name] ?? ''}
                        currentValue={props[def.name] ?? ''}
                        onChange={v => setEdits(e => ({ ...e, [def.name]: v }))}
                      />
                    ))}
                  </div>
                ))}
              </div>
              {/* Dataset Property Groups */}
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', fontFamily: 'var(--font-ui)', letterSpacing: '0.03em', marginBottom: 4, marginTop: 8 }}>
                  Default Dataset Properties
                </div>
                {datasetPropGroups.map(group => (
                  <div key={group}>
                    {sectionHeader(group)}
                    {POOL_PROP_DEFS.filter(d => d.scope === 'dataset' && d.group === group).map(def => (
                      <PopoutPropRow
                        key={def.name}
                        def={def}
                        value={edits[def.name] ?? ''}
                        currentValue={props[def.name] ?? ''}
                        onChange={v => setEdits(e => ({ ...e, [def.name]: v }))}
                      />
                    ))}
                  </div>
                ))}
              </div>
              {/* Danger Zone */}
              <div style={{ marginTop: 24, marginBottom: 24 }}>
                <div style={{ borderTop: '1px solid rgba(239,68,68,0.25)', paddingTop: 16 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--danger)', fontFamily: 'var(--font-ui)', marginBottom: 12 }}>
                    Danger Zone
                  </div>
                  <div style={{ background: 'rgba(239,68,68,0.04)', border: '1px solid rgba(239,68,68,0.15)', borderRadius: 'var(--radius)', padding: '12px 14px' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'var(--font-ui)', marginBottom: 4 }}>Destroy Pool</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-ui)', marginBottom: 12, lineHeight: 1.5 }}>
                      Permanently destroys this pool and all data within it. This cannot be undone.
                    </div>
                    {!showDestroyDialog ? (
                      <button
                        className="btn"
                        style={{ height: 30, padding: '0 14px', fontSize: 11, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--danger)', cursor: 'pointer', borderRadius: 'var(--radius)', display: 'flex', alignItems: 'center', gap: 6 }}
                        onClick={() => { setShowDestroyDialog(true); setDestroyInput(''); }}
                      >
                        <Trash2 size={11} /> Destroy Pool
                      </button>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <div style={{ fontSize: 11, color: 'var(--danger)', fontFamily: 'var(--font-ui)' }}>
                          Type <strong>{poolName}</strong> to confirm:
                        </div>
                        <input
                          type="text"
                          value={destroyInput}
                          onChange={e => setDestroyInput(e.target.value)}
                          placeholder={poolName}
                          style={{ ...S.modal.input, fontSize: 12, padding: '6px 10px', borderColor: 'rgba(239,68,68,0.4)' }}
                          autoFocus
                        />
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            className="btn btn-secondary"
                            style={{ flex: 1, fontSize: 11, padding: '5px 10px' }}
                            onClick={() => { setShowDestroyDialog(false); setDestroyInput(''); }}
                          >
                            Cancel
                          </button>
                          <button
                            className="btn"
                            disabled={destroyInput !== poolName || destroying}
                            style={{ flex: 1, fontSize: 11, padding: '5px 10px', background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)', color: 'var(--danger)', cursor: destroyInput !== poolName ? 'not-allowed' : 'pointer', borderRadius: 'var(--radius)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, opacity: destroyInput !== poolName ? 0.5 : 1 }}
                            onClick={async () => {
                              if (destroyInput !== poolName) return;
                              setDestroying(true);
                              try {
                                await api.destroyPool(poolName);
                                // Pre-warm the disk cache: backend already ran labelclear+wipefs
                                // and busted the Redis key; this call re-populates it with
                                // clean state so any picker that opens next gets in_use:false.
                                api.getEnrichedDisks().catch(() => {});
                                onSaved();
                                close();
                              } catch (err: any) {
                                notify({ type: 'error', title: 'Destroy Failed', message: err.message || 'Destroy failed' });
                                setDestroying(false);
                              }
                            }}
                          >
                            {destroying ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : <Trash2 size={11} />}
                            {destroying ? 'Destroying…' : 'Confirm Destroy'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{
          borderTop: '1px solid var(--border)', padding: '14px 20px', flexShrink: 0,
          background: 'var(--bg-elevated)',
        }}>
          {edits['compression'] && props['compression'] && edits['compression'] !== props['compression'] && (
            <div style={{
              background: 'rgba(234,179,8,0.06)',
              border: '1px solid rgba(234,179,8,0.25)',
              borderRadius: 'var(--radius-sm)',
              padding: '10px 12px',
              marginBottom: 12,
              display: 'flex',
              gap: 8,
              alignItems: 'flex-start'
            }}>
              <AlertTriangle size={15} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 1 }} />
              <span style={{ fontSize: 11, color: 'var(--warning)', fontFamily: 'var(--font-ui)', lineHeight: '1.4' }}>
                <strong>Notice:</strong> Changing compression only affects newly written data. To compress existing files, you should run a <strong>Pool Rewrite (scrub)</strong> after saving.
              </span>
            </div>
          )}
          {pendingCount > 0 && (
            <div style={{ fontSize: 11, color: 'var(--accent)', fontFamily: 'var(--font-ui)', marginBottom: 10 }}>
              {pendingCount} pending change{pendingCount !== 1 ? 's' : ''}
            </div>
          )}
          <button
            className="btn btn-primary"
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 8 }}
            onClick={handleSave}
            disabled={saving || loading}
          >
            {saving && <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />}
            {saving ? 'Saving…' : pendingCount > 0 ? `Save ${pendingCount} Change${pendingCount !== 1 ? 's' : ''}` : 'Save Changes'}
          </button>
          <button className="btn btn-secondary" style={{ width: '100%' }} onClick={close}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}

function PopoutPropRow({
  def, value, currentValue, onChange,
}: {
  def: PropDef; value: string; currentValue: string; onChange: (v: string) => void;
}) {
  const changed = value !== currentValue;
  const inputStyle: React.CSSProperties = {
    width: 120, height: 30, padding: '0 8px', flexShrink: 0,
    background: 'var(--bg-elevated)',
    border: `1px solid ${changed ? 'var(--accent)' : 'var(--border)'}`,
    borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)',
    fontFamily: 'var(--font-mono)', fontSize: 11, outline: 'none',
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: changed ? 'var(--accent)' : 'var(--text-primary)', fontFamily: 'var(--font-ui)' }}>
          {def.label}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-ui)', marginTop: 2, lineHeight: 1.4 }}>
          {(def as any).desc || def.name}
        </div>
      </div>

      {def.type === 'toggle' ? (
        <button
          onClick={() => onChange(value === 'on' ? 'off' : 'on')}
          style={{
            width: 44, height: 22, borderRadius: 11, flexShrink: 0,
            background: value === 'on' ? 'var(--success)' : 'var(--bg-elevated)',
            border: `1px solid ${value === 'on' ? 'var(--success)' : changed ? 'var(--accent)' : 'var(--border)'}`,
            position: 'relative', cursor: 'pointer', transition: 'all 0.2s',
          }}
        >
          <div style={{
            position: 'absolute', top: 2,
            left: value === 'on' ? 22 : 2,
            width: 16, height: 16, borderRadius: 8,
            background: '#fff', transition: 'left 0.2s',
          }} />
        </button>
      ) : def.type === 'select' ? (
        <select value={value} onChange={e => onChange(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
          {(def.options || []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
        </select>
      ) : (
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="value"
          style={inputStyle}
        />
      )}
    </div>
  );
}

/* ── Raid type helpers ─────────────────────────────────────────────────────────── */
function raidColor(raidType: string): string {
  if (raidType.startsWith('Mirror'))  return 'var(--success)';
  if (raidType.startsWith('RAIDZ-1')) return 'var(--info)';
  if (raidType.startsWith('RAIDZ-2')) return 'var(--accent)';
  if (raidType.startsWith('RAIDZ-3')) return 'var(--warning)';
  if (raidType === 'Stripe')          return 'var(--danger)';
  return 'var(--text-muted)';
}

/* ── Main Component ───────────────────────────────────────────────────────────── */
export default function StoragePools({ pools, onRefresh, zfsVersion }: StoragePoolsProps) {
  const { notify } = useNotifications();
  const isMobile = useIsMobile();
  const [scrubState,       setScrubState]       = useState<Record<string, ScrubState>>({});
  const [scrubProgress,    setScrubProgress]    = useState<Record<string, ScrubProgress>>({});
  const [expansionProgress,setExpansionProgress] = useState<Record<string, ExpansionProgress>>({});
  const [activeRewrites,   setActiveRewrites]   = useState<RewriteEntry[]>([]);
  const [expandedPool,  setExpandedPool]  = useState<string | null>(null);
  const [poolStatus,    setPoolStatus]    = useState<Record<string, string>>({});
  const [statusLoading, setStatusLoading] = useState<string | null>(null);
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [showCreate,    setShowCreate]    = useState(false);
  const [showImport,    setShowImport]    = useState(false);
  const [expandTarget,  setExpandTarget]  = useState<string | null>(null);
  const [replaceTarget, setReplaceTarget] = useState<{ pool: string; preselectedDisk?: string } | null>(null);
  const [smartTarget,   setSmartTarget]   = useState<string | null>(null);
  const [poolVdevs,     setPoolVdevs]     = useState<Record<string, any[]>>({});
  const [settingsOpenFor,    setSettingsOpenFor]    = useState<string | null>(null);
  const [featuresOpenFor,    setFeaturesOpenFor]    = useState<string | null>(null);
  const [autoMountOpenFor,   setAutoMountOpenFor]   = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);

  const pollTimers = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const postOpPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const vdevPollRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const animEnabled = localStorage.getItem('page_animations') !== 'false';

  // zpool resilver was introduced in OpenZFS 2.1.0
  const resilverAvailable = (() => {
    if (!zfsVersion) return true;
    const m = zfsVersion.match(/(\d+)\.(\d+)/);
    if (!m) return true;
    return parseInt(m[1]) * 100 + parseInt(m[2]) >= 201;
  })();

  // After any pool-modifying operation, poll aggressively for 30s so resilver/expand status shows up quickly
  const startPostOpPoll = () => {
    if (postOpPollRef.current) clearInterval(postOpPollRef.current);
    let elapsed = 0;
    postOpPollRef.current = setInterval(() => {
      elapsed += 2000;
      onRefresh();
      if (elapsed >= 30000) {
        clearInterval(postOpPollRef.current!);
        postOpPollRef.current = null;
      }
    }, 2000);
  };

  useEffect(() => () => {
    if (postOpPollRef.current) clearInterval(postOpPollRef.current);
  }, []);

  const showToast = (msg: string, type: 'success' | 'error') => {
    notify({ type, title: type === 'success' ? 'Success' : 'Error', message: msg });
  };

  // Invalidate and re-fetch vdevs for a pool so the disk list reflects new state immediately
  const refreshPoolVdevs = (poolName: string) => {
    setPoolVdevs(prev => {
      const next = { ...prev };
      delete next[poolName];
      return next;
    });
    api.getPoolVdevs(poolName)
      .then(res => setPoolVdevs(prev => ({ ...prev, [poolName]: res.vdevs || [] })))
      .catch(() => {});
  };

  // Auto-refresh vdevs every 2s so disk states (replacing, faulted, etc.) update in real-time.
  useEffect(() => {
    if (pools.length === 0) return;
    const names = pools.map(p => p.name);
    const fetchVdevs = () => names.forEach(n =>
      api.getPoolVdevs(n)
        .then(res => setPoolVdevs(prev => ({ ...prev, [n]: res.vdevs || [] })))
        .catch(() => {})
    );
    fetchVdevs();
    if (vdevPollRef.current) clearInterval(vdevPollRef.current);
    vdevPollRef.current = setInterval(fetchVdevs, 2000);
    return () => { if (vdevPollRef.current) { clearInterval(vdevPollRef.current); vdevPollRef.current = null; } };
  }, [pools.map(p => p.name).join(',')]);  // re-run only when pool list changes

  useEffect(() => {
    pools.forEach(pool => {
      api.getScrubStatus(pool.name).then(res => {
        if (res.in_progress) {
          setScrubState(s => ({ ...s, [pool.name]: 'running' }));
          setScrubProgress(p => ({ ...p, [pool.name]: {
            inProgress: true, done: false,
            progress: res.progress || 0, timeRemaining: res.time_remaining || '', scan: res.scan || '',
            scanDetail: res.scan_detail || '', isResilver: !!(res.is_resilver),
            scanSpeed: res.scan_speed || '',
          }}));
          startScrubPolling(pool.name);
        }
        if (res.expansion?.in_progress) {
          setExpansionProgress(p => ({ ...p, [pool.name]: {
            inProgress: true,
            vdev: res.expansion.vdev || '',
            progress: res.expansion.progress || 0,
            eta: res.expansion.eta || '',
            speed: res.expansion.speed || '',
            copied: res.expansion.copied || '',
            detail: res.expansion.detail || '',
          }}));
          startScrubPolling(pool.name);
        }
      }).catch(() => {});
    });
  }, [pools]);

  const getPoolRaidType = (poolName: string): string => {
    const vdevs = poolVdevs[poolName] || [];
    if (vdevs.length === 0) return '—';
    const types = [...new Set(vdevs.map((v: any) => v.type as string))];
    if (types.length === 1) {
      const t = types[0];
      if (t === 'mirror') return 'Mirror';
      if (t === 'raidz1') return 'RAIDZ-1';
      if (t === 'raidz2') return 'RAIDZ-2';
      if (t === 'raidz3') return 'RAIDZ-3';
      if (t === 'stripe') return 'Stripe';
    }
    return types.map(t => t.toUpperCase()).join('+');
  };

  const getPoolDisks = (poolName: string): { path: string; state: string; replacing_with?: string; via_spare?: boolean; being_replaced_by?: string }[] => {
    const vdevs = poolVdevs[poolName] || [];
    // Exclude spare/log/cache vdevs — they get their own sections.
    return vdevs.filter((v: any) => !['spare', 'log', 'cache'].includes(v.type)).flatMap((v: any) => v.disks || []);
  };

  // Set of all disk paths currently in use by any pool
  const usedDisksSet = new Set<string>(
    Object.values(poolVdevs)
      .flatMap((vdevs: any) => (vdevs || []).flatMap((v: any) => (v.disks || []).map((d: any) => d.path || d)))
  );

  const startScrubPolling = (poolName: string) => {
    if (pollTimers.current[poolName]) return;
    pollTimers.current[poolName] = setInterval(async () => {
      try {
        const res = await api.getScrubStatus(poolName);
        setScrubProgress(p => ({ ...p, [poolName]: {
          inProgress: res.in_progress, done: res.done,
          progress: res.progress, timeRemaining: res.time_remaining, scan: res.scan,
          scanDetail: res.scan_detail || '', isResilver: !!(res.is_resilver),
          scanSpeed: res.scan_speed || '',
        }}));
        if (res.expansion) {
          setExpansionProgress(p => ({ ...p, [poolName]: {
            inProgress: res.expansion.in_progress || false,
            vdev: res.expansion.vdev || '',
            progress: res.expansion.progress || 0,
            eta: res.expansion.eta || '',
            speed: res.expansion.speed || '',
            copied: res.expansion.copied || '',
            detail: res.expansion.detail || '',
          }}));
        }
        if (!res.in_progress && !res.expansion?.in_progress) {
          clearInterval(pollTimers.current[poolName]);
          delete pollTimers.current[poolName];
          setScrubState(s => ({ ...s, [poolName]: 'success' }));
          setTimeout(() => setScrubState(s => ({ ...s, [poolName]: 'idle' })), 4000);
        }
      } catch {
        clearInterval(pollTimers.current[poolName]);
        delete pollTimers.current[poolName];
      }
    }, 1000);
  };

  // Poll active rewrites every second
  const rewritePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    const poll = () => api.getActiveRewrites().then(res => setActiveRewrites(res.active || [])).catch(() => {});
    poll();
    rewritePollRef.current = setInterval(poll, 1000);
    return () => { if (rewritePollRef.current) clearInterval(rewritePollRef.current); };
  }, []);

  useEffect(() => {
    return () => { Object.values(pollTimers.current).forEach(clearInterval); };
  }, []);

  const handleScrub = async (poolName: string) => {
    setConfirmState({
      title: "Start ZFS Scrub",
      message: `Are you sure you want to start a ZFS scrub on pool "${poolName}"? A scrub validates the integrity of all data by reading every block and comparing its checksum. This can consume significant disk bandwidth and temporarily impact system performance.`,
      onConfirm: async () => {
        setScrubState(s => ({ ...s, [poolName]: 'running' }));
        setScrubProgress(p => ({ ...p, [poolName]: { inProgress: true, done: false, progress: 0, timeRemaining: '', scan: '', scanDetail: '', isResilver: false } }));
        try {
          await api.startScrub(poolName);
          showToast(`Scrub started on ${poolName}`, 'success');
          startScrubPolling(poolName);
        } catch (err: any) {
          setScrubState(s => ({ ...s, [poolName]: 'error' }));
          showToast(err.message || 'Scrub failed', 'error');
          setTimeout(() => setScrubState(s => ({ ...s, [poolName]: 'idle' })), 3000);
        }
      }
    });
  };

  const handleResilver = async (poolName: string) => {
    setConfirmState({
      title: "Start ZFS Resilver",
      message: `Force an immediate resilver on pool "${poolName}"? This runs zpool resilver and re-synchronizes all mirrored or parity data. It may impact I/O performance while running.`,
      onConfirm: async () => {
        try {
          await api.resilverPool(poolName);
          showToast(`Resilver started on ${poolName}`, 'success');
          setScrubState(s => ({ ...s, [poolName]: 'running' }));
          startScrubPolling(poolName);
        } catch (err: any) {
          showToast(err.message || 'Rewrite failed', 'error');
        }
      }
    });
  };

  const handleActivateSpare = async (poolName: string, failedDisk: string, spareDisk: string) => {
    try {
      // ZFS needs full /dev/ path for the new disk, not just the short name
      const newDisk = spareDisk.startsWith('/dev/') ? spareDisk : `/dev/${spareDisk}`;
      await api.replaceDisk(poolName, failedDisk, newDisk, false);
      showToast(`Spare ${spareDisk} activated — replacing ${failedDisk}`, 'success');
      onRefresh();
    } catch (err: any) {
      showToast(err.message || 'Failed to activate spare', 'error');
    }
  };

  const handleRemoveDevice = (poolName: string, device: string, label: string) => {
    setConfirmState({
      title: `Remove ${label}`,
      message: `Remove "${device}" from pool "${poolName}"? The pool will continue without it.`,
      onConfirm: async () => {
        try {
          await api.removeDevice(poolName, device);
          showToast(`${device} removed from ${poolName}`, 'success');
          refreshPoolVdevs(poolName);
          onRefresh();
        } catch (err: any) {
          showToast(err.message || 'Remove failed', 'error');
        }
      },
    });
  };

  const handleToggleStatus = async (poolName: string) => {
    if (expandedPool === poolName) {
      setExpandedPool(null);
      if (statusPollRef.current) { clearInterval(statusPollRef.current); statusPollRef.current = null; }
      return;
    }
    setExpandedPool(poolName);
    setStatusLoading(poolName);
    const fetchStatus = async () => {
      try {
        const res = await api.getPoolStatus(poolName);
        setPoolStatus(s => ({ ...s, [poolName]: res.status }));
      } catch (err: any) {
        setPoolStatus(s => ({ ...s, [poolName]: `Error: ${(err as any).message}` }));
      } finally { setStatusLoading(null); }
    };
    await fetchStatus();
    if (statusPollRef.current) clearInterval(statusPollRef.current);
    statusPollRef.current = setInterval(fetchStatus, 1000);
  };

  useEffect(() => {
    return () => { if (statusPollRef.current) clearInterval(statusPollRef.current); };
  }, []);

  return (
    <PageTransition>
    <div style={{ paddingBottom: 48 }}>

      {/* Modals */}
      {showCreate && (
        <CreatePoolModal
          onClose={() => setShowCreate(false)}
          onSuccess={name => { setShowCreate(false); showToast(`Pool "${name}" created`, 'success'); onRefresh(); }}
          usedDisks={usedDisksSet}
        />
      )}
      {showImport && (
        <ImportPoolModal
          onClose={() => setShowImport(false)}
          onSuccess={() => { showToast('Pool imported', 'success'); setShowImport(false); onRefresh(); }}
        />
      )}
      {expandTarget && (
        <ExpandPoolModal
          poolName={expandTarget}
          poolVdevs={poolVdevs[expandTarget] || []}
          zfsVersion={zfsVersion}
          onClose={() => setExpandTarget(null)}
          onSuccess={() => { showToast(`Disk added to pool "${expandTarget}"`, 'success'); refreshPoolVdevs(expandTarget); setExpandTarget(null); onRefresh(); startPostOpPoll(); }}
        />
      )}
      {featuresOpenFor && (
        <FeaturesModal poolName={featuresOpenFor} onClose={() => setFeaturesOpenFor(null)} />
      )}
      {replaceTarget && (
        <ReplaceDiskModal
          key={`${replaceTarget.pool}-${replaceTarget.preselectedDisk || 'pick'}`}
          poolName={replaceTarget.pool}
          poolDisks={getPoolDisks(replaceTarget.pool)}
          preselectedDisk={replaceTarget.preselectedDisk}
          onClose={() => setReplaceTarget(null)}
          onSuccess={() => {
            const pName = replaceTarget.pool;
            showToast('Disk replacement started', 'success');
            refreshPoolVdevs(pName);
            setScrubState(s => ({ ...s, [pName]: 'running' }));
            setScrubProgress(p => ({ ...p, [pName]: { inProgress: true, done: false, progress: 0, timeRemaining: '', scan: '', scanDetail: '', isResilver: true, scanSpeed: '' } }));
            setReplaceTarget(null);
            onRefresh();
            startPostOpPoll();
            startScrubPolling(pName);
          }}
        />
      )}
      {smartTarget && <SmartModal device={smartTarget} onClose={() => setSmartTarget(null)} />}
      {autoMountOpenFor && (
        <AutoMountModal
          poolName={autoMountOpenFor}
          onClose={() => setAutoMountOpenFor(null)}
          onSuccess={() => { setAutoMountOpenFor(null); }}
        />
      )}
      {settingsOpenFor && (
        <SettingsPopout
          poolName={settingsOpenFor}
          onClose={() => setSettingsOpenFor(null)}
          onSaved={() => { showToast(`Settings saved for ${settingsOpenFor}`, 'success'); onRefresh(); }}
        />
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-ui)', textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>
            {pools.length} pool{pools.length !== 1 ? 's' : ''}
          </span>
          {zfsVersion && (
            <span className="badge" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>
              {zfsVersion.replace('zfs-', '')}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={onRefresh} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <RefreshCw size={13} /> Refresh
          </button>
          <button className="btn btn-secondary" onClick={() => setShowImport(true)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Download size={13} /> Import
          </button>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)} style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
            <Plus size={13} /> Create Pool
          </button>
        </div>
      </div>

      {/* Pool cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {pools.map((pool, pi) => {
          const state        = scrubState[pool.name] || 'idle';
          const progress     = scrubProgress[pool.name];
          const expansionProg = expansionProgress[pool.name];
          const isExpanded = expandedPool === pool.name;
          const raidType   = getPoolRaidType(pool.name);
          const disks      = getPoolDisks(pool.name);
          const rc         = raidColor(raidType);
          const capColor   = pool.cap > 90 ? 'var(--danger)' : pool.cap > 80 ? 'var(--warning)' : 'var(--accent)';
          const isOnline   = pool.health === 'ONLINE';

          // Hot spare / cache / log detection
          const allVdevs    = poolVdevs[pool.name] || [];
          const spareDisks  = allVdevs.filter((v: any) => v.type === 'spare').flatMap((v: any) => v.disks || []);
          const cacheDisks  = allVdevs.filter((v: any) => v.type === 'cache').flatMap((v: any) => v.disks || []);
          const logDisks    = allVdevs.filter((v: any) => v.type === 'log').flatMap((v: any) => v.disks || []);
          const availSpares = spareDisks.filter((d: any) => d.state === 'AVAIL');
          const failedDisks = allVdevs
            .filter((v: any) => !['spare', 'log', 'cache'].includes(v.type))
            .flatMap((v: any) => v.disks || [])
            .filter((d: any) => ['FAULTED', 'REMOVED', 'UNAVAIL', 'OFFLINE'].includes(d.state));
          const canActivateSpare = availSpares.length > 0 && failedDisks.length > 0;

          return (
            <motion.div
              key={pool.name}
              initial={animEnabled ? { opacity: 0, y: -8 } : false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18, delay: Math.min(pi, 20) * 30 / 1000 }}
              style={{ background: 'var(--bg-surface)', border: `1px solid ${isOnline ? 'var(--border)' : 'rgba(239,68,68,0.3)'}`, borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}
            >

              {/* Card header */}
              <div style={{ padding: isMobile ? '14px 16px' : '20px 24px', borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: isMobile ? 'flex-start' : 'center', flexDirection: isMobile ? 'column' : 'row', justifyContent: 'space-between', gap: isMobile ? 12 : 0, marginBottom: 16 }}>
                  {/* Name + badges */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <div style={{ width: 36, height: 36, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <Database size={16} style={{ color: 'var(--accent)' }} />
                    </div>
                    <div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>{pool.name}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                        <span className={isOnline ? 'badge badge-success' : pool.health === 'DEGRADED' ? 'badge badge-warning' : 'badge badge-danger'}>
                          {pool.health}
                        </span>
                        {raidType !== '—' && (
                          <span className="badge" style={{ color: rc, borderColor: rc + '44', background: rc + '18' }}>{raidType}</span>
                        )}
                        {(pool as any).dedup && (pool as any).dedup !== '1.00x' && (
                          <span className="badge">DEDUP {(pool as any).dedup}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div className="pool-actions" style={{ display: 'flex', gap: 6, flexShrink: 0, flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
                    <button
                      className="btn btn-secondary pool-action-btn"
                      onClick={() => handleScrub(pool.name)}
                      disabled={state === 'running'}
                      title="Scrub pool"
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        color: state === 'running' ? 'var(--warning)' : state === 'success' ? 'var(--success)' : state === 'error' ? 'var(--danger)' : 'var(--text-secondary)',
                        borderColor: state === 'running' ? 'rgba(245,158,11,0.3)' : state === 'success' ? 'rgba(34,197,94,0.3)' : undefined,
                      }}
                    >
                      {state === 'running' && <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />}
                      {state === 'success' && <CheckCircle size={13} />}
                      {state === 'error'   && <XCircle size={13} />}
                      {state === 'idle'    && <Activity size={13} />}
                      {!isMobile && (state === 'running' ? 'Scrubbing…' : state === 'success' ? 'Done' : state === 'error' ? 'Failed' : 'Scrub')}
                      {isMobile && (state === 'running' ? 'Scrub…' : state === 'success' ? 'Done' : state === 'error' ? 'Err' : 'Scrub')}
                    </button>
                    <button
                      className="btn btn-secondary pool-action-btn"
                      onClick={() => {
                        if (pool.health === 'DEGRADED' || pool.health === 'FAULTED') {
                          const degradedDisks = disks.filter(d =>
                            (d.state === 'DEGRADED' || d.state === 'FAULTED' ||
                             d.state === 'UNAVAIL'  || d.state === 'REMOVED') &&
                            d.path // only auto-select if we know the disk path
                          );
                          if (degradedDisks.length === 1) {
                            setReplaceTarget({ pool: pool.name, preselectedDisk: degradedDisks[0].path });
                            return;
                          }
                        }
                        setReplaceTarget({ pool: pool.name });
                      }}
                      title="Replace disk"
                      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                      <ArrowLeftRight size={13} /> {!isMobile && 'Replace'}
                    </button>
                    <button className="btn btn-secondary pool-action-btn" onClick={() => setAutoMountOpenFor(pool.name)} title="Auto-mount / import config" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Download size={13} /> {!isMobile && 'Mount'}
                    </button>
                    <button
                      className="btn btn-secondary pool-action-btn"
                      onClick={() => setFeaturesOpenFor(pool.name)}
                      title="Pool Features"
                      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                      <Layers size={13} /> {!isMobile && 'Features'}
                    </button>
                    <button className="btn btn-secondary pool-action-btn" onClick={() => handleToggleStatus(pool.name)} title={isExpanded ? 'Hide status' : 'Show pool status'} style={{ display: 'flex', alignItems: 'center', gap: 6, color: isExpanded ? 'var(--accent)' : undefined, borderColor: isExpanded ? 'var(--accent-mid)' : undefined }}>
                      <Info size={13} />
                      {!isMobile && (isExpanded ? 'Hide' : 'Status')}
                    </button>
                    <button
                      className="btn btn-secondary pool-action-btn"
                      onClick={() => setSettingsOpenFor(settingsOpenFor === pool.name ? null : pool.name)}
                      title="Pool Settings"
                      style={{ display: 'flex', alignItems: 'center', gap: 6, color: settingsOpenFor === pool.name ? 'var(--accent)' : undefined, borderColor: settingsOpenFor === pool.name ? 'var(--accent-mid)' : undefined }}
                    >
                      <Settings size={13} />
                    </button>
                  </div>
                </div>

                {/* Usage bar */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)' }}>Usage</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: capColor, fontWeight: 700 }}>{pool.cap}%</span>
                  </div>
                  <div className="progress-track" style={{ height: 6 }}>
                    <div className="progress-fill" style={{ width: `${Math.min(pool.cap, 100)}%`, background: capColor }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5 }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{pool.alloc} used</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{pool.free} / {pool.size}</span>
                  </div>
                </div>
              </div>

              {/* Hot spare available banner */}
              {canActivateSpare && (
                <div style={{ padding: '10px 24px', background: 'rgba(245,158,11,0.06)', borderBottom: '1px solid rgba(245,158,11,0.22)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <AlertTriangle size={13} style={{ color: 'var(--warning)', flexShrink: 0 }} />
                    <div>
                      <span style={{ fontSize: 12, color: 'var(--warning)', fontWeight: 600 }}>Hot spare available</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>
                        {failedDisks[0]?.path} failed — spare {availSpares[0]?.path} not auto-activated (zed not running?)
                      </span>
                    </div>
                  </div>
                  <button
                    className="btn btn-secondary"
                    style={{ fontSize: 11, flexShrink: 0, borderColor: 'rgba(245,158,11,0.5)', color: 'var(--warning)' }}
                    onClick={() => handleActivateSpare(pool.name, failedDisks[0].path, availSpares[0].path)}
                  >
                    Activate Spare
                  </button>
                </div>
              )}

              {/* Stats row & Scrub Progress */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 0, padding: '0', borderBottom: '1px solid var(--border)' }}>
                {[
                  { label: 'Fragmentation', value: `${(pool as any).frag ?? 0}%`, color: (pool as any).frag > 20 ? 'var(--warning)' : 'var(--text-primary)' },
                  { label: 'Dedup Ratio',   value: (pool as any).dedup || '1.00x', color: 'var(--text-primary)' },
                  { label: 'Disks',         value: disks.length > 0 ? String(disks.length) : '—', color: 'var(--text-primary)' },
                  { label: 'RAID Type',     value: raidType,                       color: rc },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{ padding: isMobile ? '10px 14px' : '14px 20px', borderRight: '1px solid var(--border)', flex: '1 1 auto', minWidth: isMobile ? '50%' : 120, boxSizing: 'border-box' as const }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', fontFamily: 'var(--font-ui)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                      {label}
                      {label === 'Fragmentation' && (
                        <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }} className="frag-info-wrap">
                          <Info size={10} style={{ color: 'var(--text-muted)', cursor: 'help', flexShrink: 0 }} />
                          <span className="frag-tooltip">
                            Fragmentation measures how scattered free space is within the pool's metadata. High fragmentation (&gt;20%) can reduce write performance and increase memory usage. It does not affect data integrity. Running a scrub or having contiguous free space reduces it over time.
                          </span>
                        </span>
                      )}
                    </div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600, color }}>{value}</div>
                  </div>
                ))}

                {/* Scrub or Resilver progress */}
                {state === 'running' && progress && (
                  progress.isResilver ? (
                    <div style={{ flex: 1, minWidth: 200, padding: '10px 20px', background: 'rgba(20,184,166,0.04)', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontSize: 11, color: 'var(--success)', fontFamily: 'var(--font-ui)', display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> Resilvering
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--success)', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{progress.progress.toFixed(2)}%</span>
                      </div>
                      <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 9999, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${progress.progress}%`, background: 'var(--success)', borderRadius: 9999, transition: 'width 0.5s' }} />
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 4 }}>
                        Resilvering: {progress.progress.toFixed(2)}% done{progress.timeRemaining ? `, ${progress.timeRemaining} to go` : ''}{progress.scanSpeed ? ` at ${progress.scanSpeed}` : ''}
                      </div>
                    </div>
                  ) : (
                    <div style={{ flex: 1, minWidth: 200, padding: '10px 20px', background: 'rgba(245,158,11,0.04)', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontSize: 11, color: 'var(--warning)', fontFamily: 'var(--font-ui)', display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> Scrubbing
                        </span>
                        <div style={{ display: 'flex', gap: 12, fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                          {progress.timeRemaining && <span style={{ color: 'var(--text-muted)' }}>{progress.timeRemaining} rem</span>}
                          <span style={{ color: 'var(--warning)', fontWeight: 700 }}>{progress.progress.toFixed(1)}%</span>
                        </div>
                      </div>
                      <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 9999, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${progress.progress}%`, background: 'var(--warning)', borderRadius: 9999, transition: 'width 0.5s' }} />
                      </div>
                    </div>
                  )
                )}

                {/* Rewrite progress (dataset-level rewrites for this pool) */}
                {activeRewrites.filter(r => r.pool === pool.name).map(r => {
                  const { pct, label } = computeRewrite(r);
                  return (
                    <div key={r.name} style={{ flex: 1, minWidth: 200, padding: '10px 20px', background: 'rgba(56,189,248,0.04)', borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontSize: 11, color: 'var(--info)', fontFamily: 'var(--font-ui)', display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> Rewriting
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--info)', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{pct.toFixed(2)}%</span>
                      </div>
                      <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 9999, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${Math.min(pct, 100)}%`, background: 'var(--info)', borderRadius: 9999, transition: 'width 1s' }} />
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 4 }}>{label}</div>
                    </div>
                  );
                })}

                {/* RAIDZ Expansion progress */}
                {expansionProg?.inProgress && (
                  <div style={{ flex: 1, minWidth: 220, padding: '10px 20px', background: 'rgba(99,102,241,0.06)', borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                      <span style={{ fontSize: 11, color: 'var(--accent)', fontFamily: 'var(--font-ui)', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
                        Expanding {expansionProg.vdev}
                      </span>
                      <div style={{ display: 'flex', gap: 12, fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                        {expansionProg.eta && <span style={{ color: 'var(--text-muted)' }}>{expansionProg.eta} rem</span>}
                        <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{expansionProg.progress.toFixed(2)}%</span>
                      </div>
                    </div>
                    <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 9999, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${expansionProg.progress}%`, background: 'var(--accent)', borderRadius: 9999, transition: 'width 1s' }} />
                    </div>
                    {expansionProg.detail && (
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 4 }}>
                        Expanding {expansionProg.vdev}: {expansionProg.detail.replace(' copied', '')}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Disk list */}
              {disks.length > 0 && (
                <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>Disks</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 6 }}>
                    {disks.map((disk, di) => (
                      <DiskRow key={di} disk={disk} poolName={pool.name}
                        onReplace={d => setReplaceTarget({ pool: pool.name, preselectedDisk: d })}
                        onSmartClick={d => setSmartTarget(d)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Hot Spares */}
              {spareDisks.length > 0 && (
                <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>Hot Spares</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 6 }}>
                    {spareDisks.map((sd: any, si: number) => {
                      const spareShort = (sd.path || '').replace(/^\/dev\//, '');
                      // When INUSE: find the data disk this spare is covering for
                      const coveredDisk = sd.state === 'INUSE'
                        ? allVdevs
                            .filter((v: any) => !['spare', 'log', 'cache'].includes(v.type))
                            .flatMap((v: any) => v.disks || [])
                            .find((d: any) => (d.replacing_with || '').replace(/^\/dev\//, '') === spareShort)
                        : null;
                      const coveredName = coveredDisk ? (coveredDisk.path || '').replace(/^\/dev\//, '') : null;

                      const spareState = sd.state === 'AVAIL'
                        ? 'available'
                        : sd.state === 'INUSE'
                        ? coveredName ? `replacing ${coveredName}` : 'in use'
                        : sd.state.toLowerCase();
                      const spareColor = sd.state === 'AVAIL' ? 'var(--success)' : sd.state === 'INUSE' ? 'var(--warning)' : 'var(--danger)';
                      return (
                        <div key={si} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--bg-elevated)', border: `1px solid ${sd.state === 'INUSE' ? 'rgba(245,158,11,0.3)' : 'var(--border)'}`, borderRadius: 'var(--radius)' }}
                          onMouseEnter={e => (e.currentTarget as HTMLElement).querySelector('.spare-actions')?.setAttribute('style', 'display:flex;gap:4px;opacity:1')}
                          onMouseLeave={e => (e.currentTarget as HTMLElement).querySelector('.spare-actions')?.setAttribute('style', 'display:flex;gap:4px;opacity:0')}
                        >
                          <HardDrive size={13} style={{ color: spareColor, flexShrink: 0 }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-primary)', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {spareShort || '(missing)'}
                            </div>
                            <div style={{ fontSize: 9, color: spareColor, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 1 }}>{spareState}</div>
                          </div>
                          <div className="spare-actions" style={{ display: 'flex', gap: 4, opacity: 0, transition: 'opacity 0.12s' }}>
                            <button title="SMART Data" onClick={() => setSmartTarget(sd.path)} style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', color: 'var(--text-muted)' }}>
                              <Cpu size={10} />
                            </button>
                            <button title="Replace Spare" onClick={() => setReplaceTarget({ pool: pool.name, preselectedDisk: sd.path })} style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', color: 'var(--text-muted)' }}>
                              <ArrowLeftRight size={10} />
                            </button>
                            <button
                              title={sd.state === 'INUSE' ? 'Remove Spare (currently resilvering)' : 'Remove Spare'}
                              onClick={() => handleRemoveDevice(pool.name, sd.path, 'Hot Spare')}
                              disabled={!sd.path}
                              style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: sd.path ? 'pointer' : 'not-allowed', color: 'var(--text-muted)', opacity: sd.path ? 1 : 0.4 }}
                            >
                              <Trash2 size={10} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Cache (L2ARC) */}
              {cacheDisks.length > 0 && (
                <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>L2ARC Cache</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 6 }}>
                    {cacheDisks.map((cd: any, ci: number) => {
                      const cdIsReplacing = !!cd.replacing_with;
                      const cdStateLabel = cdIsReplacing
                        ? `${cd.state.toLowerCase()} → ${cd.replacing_with}`
                        : cd.state === 'ONLINE' ? 'l2arc' : cd.state.toLowerCase();
                      const cdColor = cdIsReplacing || cd.state !== 'ONLINE' ? 'var(--warning)' : 'var(--info)';
                      return (
                        <div key={ci} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}
                          onMouseEnter={e => (e.currentTarget as HTMLElement).querySelector('.cache-actions')?.setAttribute('style', 'display:flex;gap:4px;opacity:1')}
                          onMouseLeave={e => (e.currentTarget as HTMLElement).querySelector('.cache-actions')?.setAttribute('style', 'display:flex;gap:4px;opacity:0')}
                        >
                          <HardDrive size={13} style={{ color: cdColor, flexShrink: 0 }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-primary)', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {(cd.path || '').replace(/^\/dev\//, '')}
                            </div>
                            <div style={{ fontSize: 9, color: cdColor, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 1 }}>{cdStateLabel}</div>
                          </div>
                          <div className="cache-actions" style={{ display: 'flex', gap: 4, opacity: 0, transition: 'opacity 0.12s' }}>
                            <button title="SMART Data" onClick={() => setSmartTarget(cd.path)} style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', color: 'var(--text-muted)' }}>
                              <Cpu size={10} />
                            </button>
                            <button title="Replace Cache Disk" onClick={() => setReplaceTarget({ pool: pool.name, preselectedDisk: cd.path })} style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', color: 'var(--text-muted)' }}>
                              <ArrowLeftRight size={10} />
                            </button>
                            <button title="Remove Cache Disk" onClick={() => handleRemoveDevice(pool.name, cd.path, 'L2ARC Cache')} style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', color: 'var(--text-muted)' }}>
                              <Trash2 size={10} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ZIL/SLOG (log devices) */}
              {logDisks.length > 0 && (
                <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>ZIL / SLOG</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 6 }}>
                    {logDisks.map((ld: any, li: number) => {
                      const ldIsReplacing = !!ld.replacing_with;
                      const ldStateLabel = ldIsReplacing
                        ? `${ld.state.toLowerCase()} → ${ld.replacing_with}`
                        : ld.state === 'ONLINE' ? 'slog' : ld.state.toLowerCase();
                      const ldColor = ldIsReplacing || ld.state !== 'ONLINE' ? 'var(--warning)' : 'var(--accent)';
                      return (
                        <div key={li} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}
                          onMouseEnter={e => (e.currentTarget as HTMLElement).querySelector('.log-actions')?.setAttribute('style', 'display:flex;gap:4px;opacity:1')}
                          onMouseLeave={e => (e.currentTarget as HTMLElement).querySelector('.log-actions')?.setAttribute('style', 'display:flex;gap:4px;opacity:0')}
                        >
                          <HardDrive size={13} style={{ color: ldColor, flexShrink: 0 }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-primary)', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {(ld.path || '').replace(/^\/dev\//, '')}
                            </div>
                            <div style={{ fontSize: 9, color: ldColor, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 1 }}>{ldStateLabel}</div>
                          </div>
                          <div className="log-actions" style={{ display: 'flex', gap: 4, opacity: 0, transition: 'opacity 0.12s' }}>
                            <button title="SMART Data" onClick={() => setSmartTarget(ld.path)} style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', color: 'var(--text-muted)' }}>
                              <Cpu size={10} />
                            </button>
                            <button title="Replace Log Disk" onClick={() => setReplaceTarget({ pool: pool.name, preselectedDisk: ld.path })} style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', color: 'var(--text-muted)' }}>
                              <ArrowLeftRight size={10} />
                            </button>
                            <button title="Remove Log Disk" onClick={() => handleRemoveDevice(pool.name, ld.path, 'ZIL/SLOG')} style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', color: 'var(--text-muted)' }}>
                              <Trash2 size={10} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Advanced actions */}
              <div style={{ padding: '12px 24px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-ghost" onClick={() => setExpandTarget(pool.name)} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                  <Expand size={12} /> Expand Pool
                </button>
                {resilverAvailable && (
                  <button
                    className="btn btn-ghost"
                    onClick={() => handleResilver(pool.name)}
                    disabled={state === 'running'}
                    style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}
                  >
                    <RotateCcw size={12} /> Resilver
                  </button>
                )}
              </div>

              {/* Expanded status */}
              {isExpanded && (
                <div style={{ padding: '20px 24px', borderTop: '1px solid var(--border)', background: 'rgba(0,0,0,0.2)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', fontFamily: 'var(--font-mono)' }}>
                      zpool status {pool.name}
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 7px', borderRadius: 999, background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)' }}>
                      <span className="live-dot" style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--success)', display: 'inline-block' }} />
                      <span style={{ fontSize: 9, color: 'var(--success)', fontWeight: 700, letterSpacing: '0.08em', fontFamily: 'var(--font-ui)' }}>LIVE · 1s</span>
                    </span>
                  </div>
                  {statusLoading === pool.name ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)' }}>
                      <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
                      <span style={{ fontSize: 12 }}>Fetching status…</span>
                    </div>
                  ) : (
                    <pre style={{
                      fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.8,
                      background: 'rgba(0,0,0,0.25)', border: '1px solid var(--border)',
                      borderRadius: 'var(--radius)', padding: '12px 14px',
                      overflowX: 'auto', margin: 0, whiteSpace: 'pre',
                      color: 'var(--text-secondary)',
                    }}>
                      {(poolStatus[pool.name] || 'No data available').split('\n').map((line, li) => {
                        const stateColor = line.match(/\bONLINE\b/) ? 'var(--success)'
                          : line.match(/\bDEGRADED\b/) ? '#f59e0b'
                          : line.match(/\bFAULTED\b|\bUNAVAIL\b|\bREMOVED\b|\bOFFLINE\b/) ? 'var(--danger)'
                          : undefined;
                        return (
                          <span key={li} style={{ color: stateColor, display: 'block' }}>
                            {line || ' '}
                          </span>
                        );
                      })}
                    </pre>
                  )}
                </div>
              )}

            </motion.div>
          );
        })}

        {pools.length === 0 && (
          <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '80px 40px', textAlign: 'center' }}>
            <Database size={48} style={{ color: 'var(--text-muted)', opacity: 0.3, margin: '0 auto 16px', display: 'block' }} strokeWidth={1} />
            <h3 style={{ fontFamily: 'var(--font-ui)', fontSize: 18, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>No Pools Detected</h3>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', fontFamily: 'var(--font-ui)' }}>Create or import a ZFS pool to get started.</p>
          </div>
        )}
      </div>

      {/* Fancy Confirmation Modal */}
      {confirmState && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100, backdropFilter: 'blur(4px)', animation: 'fadeIn 0.2s ease-out' }}>
          <div style={{ background: 'var(--bg-surface)', padding: 24, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', maxWidth: 400, width: '100%', boxShadow: '0 20px 50px rgba(0,0,0,0.6)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--danger)' }}>
                <AlertTriangle size={20} />
              </div>
              <h4 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>{confirmState.title}</h4>
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.5, margin: '0 0 20px 0' }}>{confirmState.message}</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
              <button className="btn btn-secondary" onClick={() => setConfirmState(null)} style={{ padding: '8px 16px', fontSize: 13 }}>Cancel</button>
              <button className="btn btn-primary" onClick={() => { confirmState.onConfirm(); setConfirmState(null); }} style={{ padding: '8px 16px', fontSize: 13, background: 'var(--danger)', borderColor: 'var(--danger)' }}>Confirm</button>
            </div>
          </div>
        </div>
      )}
    </div>
    </PageTransition>
  );
}
