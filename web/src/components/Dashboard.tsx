import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  AreaChart, Area, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import {
  HardDrive, ShieldCheck, Layers, Activity,
  Camera, TrendingUp, AlertTriangle, Database,
  ArrowUp, ArrowDown, Edit2, Check, Plus,
} from 'lucide-react';
import { ZFSPool, ZFSDataset, ZFSLog, ActiveModule } from '../types';
import { formatBytes, formatSpeed, api } from '../api';
import { useLayout } from '../hooks/useLayout';
import WidgetShell from './WidgetShell';
import PageTransition from './PageTransition';
import PhysicalDisksTable from './PhysicalDisksTable';
import ModuleWidgetRenderer from './ModuleWidgetRenderer';
import AddModuleWidgetModal from './AddModuleWidgetModal';
import { getActiveModulesCached } from '../utils/moduleCache';
import { useIsMobile } from '../hooks/useBreakpoint';

interface DashboardProps {
  pools: ZFSPool[];
  datasets: ZFSDataset[];
  snapshots: any[];
  totalCapacity: number;
  totalUsedStorage: number;
  totalRawCapacity?: number;
  totalRawUsed?: number;
  currentStats: { read: number; write: number; iops: number; readIops?: number; writeIops?: number; cpu?: number; arcHit?: number };
  liveMetrics?: any;
  systemStats?: any;
  logs?: ZFSLog[];
  loading?: boolean;
  historicalStats?: any[];
  selectedPool?: string;
  onSelectPool?: (name: string) => void;
}

/* ── Animated counter ── */
function useCounter(target: number, duration = 600) {
  const [val, setVal]    = useState(0);
  const rafRef           = useRef<number>(0);
  const startRef         = useRef<number>(0);
  const fromRef          = useRef<number>(0);
  useEffect(() => {
    fromRef.current  = val;
    startRef.current = performance.now();
    const tick = (now: number) => {
      const t    = Math.min((now - startRef.current) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      setVal(fromRef.current + (target - fromRef.current) * ease);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);
  return val;
}

function fmtBw(v: number): string {
  return formatSpeed(v * 1048576);
}
function fmtGB(v: number): string {
  return formatBytes(v * 1073741824);
}

function fmtDays(d: number): string {
  if (d < 14)  return `~${Math.round(d)} days`;
  if (d < 90)  return `~${Math.round(d / 7)} weeks`;
  if (d < 730) return `~${Math.round(d / 30)} months`;
  return `~${(d / 365).toFixed(1)} yrs`;
}

function fmtTimeUntilFull(days: number): string {
  if (!days || !isFinite(days) || days <= 0) return '–';
  if (days < 14)  return `in ~${Math.round(days)} days`;
  if (days < 90)  return `in ~${Math.round(days / 7)} weeks`;
  if (days < 730) return `in ~${Math.round(days / 30)} months`;
  return `in ~${Math.round(days / 365)} years`;
}

function fmtUsableSpace(bytes: number): string {
  if (!bytes) return '—';
  return formatBytes(bytes);
}

function colorVar(c: string): string {
  if (c === 'danger')    return 'var(--danger)';
  if (c === 'warning')   return 'var(--warning)';
  if (c === 'success')   return 'var(--success)';
  if (c === 'secondary') return 'var(--text-secondary)';
  return 'var(--text-muted)';
}

type PoolFillInfo = { days: number; rateGbDay: number; fillDate: string; color: string };

// Fill prediction from the shared backend endpoint (longest window auto-selected)
function useFillPrediction() {
  const [prediction, setPrediction] = React.useState<{
    text: string; color: string; timeText: string;
  } | null>(null);
  const [byPool, setByPool] = React.useState<Record<string, PoolFillInfo>>({});
  const loaded = React.useRef(false);

  React.useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    api.getFillPrediction('auto').then(res => {
      const map: Record<string, PoolFillInfo> = {};
      for (const pred of res.predictions) {
        const rate = parseFloat(pred.rate_gb_day);
        const isShrinking = pred.fill_date === 'Shrinking – not filling';
        const isStable = pred.fill_date === 'Stable';
        const days = (!isShrinking && !isStable && rate > 0) ? pred.free_gb / rate : 0;
        map[pred.pool] = { days, rateGbDay: rate, fillDate: pred.fill_date, color: colorVar(pred.color) };
      }
      setByPool(map);

      if (res.predictions.length > 0) {
        // Find earliest fill date from growing pools only
        const growing = res.predictions.filter(p =>
          p.fill_date !== '–' && p.fill_date !== 'Shrinking – not filling' && p.fill_date !== 'Stable'
        );
        if (growing.length > 0) {
          const earliest = growing.reduce((min, pred) =>
            (!min || pred.fill_date < min.fill_date) ? pred : min, null as any);
          const rate = parseFloat(earliest.rate_gb_day);
          const days = rate > 0 ? earliest.free_gb / rate : 0;
          setPrediction({
            text: `Full on ${earliest.fill_date}`,
            color: colorVar(earliest.color),
            timeText: fmtTimeUntilFull(days),
          });
        } else {
          // All pools are shrinking or stable
          const anyShrinking = res.predictions.some(p => p.fill_date === 'Shrinking – not filling');
          setPrediction({
            text: anyShrinking ? 'Shrinking – not filling' : 'Stable',
            color: anyShrinking ? 'var(--success)' : 'var(--text-muted)',
            timeText: '',
          });
        }
      } else {
        setPrediction({ text: '–', color: 'var(--text-muted)', timeText: '' });
      }
    }).catch(() => {
      setPrediction({ text: '–', color: 'var(--text-muted)', timeText: '' });
    });
  }, []);

  return { prediction, byPool };
}

/* ── Chart config ── */
const TOOLTIP_STYLE = {
  contentStyle: {
    background: '#18181b', border: '1px solid #3f3f46',
    borderRadius: 6, padding: '6px 10px',
    fontSize: 11, fontFamily: '"JetBrains Mono", monospace',
  },
  labelStyle: { color: '#71717a', fontSize: 10 },
};
const AXIS_TICK   = { fill: '#52525b', fontSize: 10 };
const GRID_PROPS  = { strokeDasharray: '3 6' as const, stroke: 'rgba(255,255,255,0.15)', vertical: false };
const CHART_MARGIN = { top: 24, right: 8, left: 16, bottom: 8 };
const MAX_TICKS    = 6;

/* ── Pool selector (compact — for inline use in header rows) ── */
function PoolSelector({ pools, selected, onSelect }: {
  pools: ZFSPool[];
  selected: string;
  onSelect: (name: string) => void;
}) {
  if (pools.length <= 1) return null;

  // Dropdown for 5+ pools
  if (pools.length > 4) {
    const cur = pools.find(p => p.name === selected);
    const dotColor = cur?.health === 'ONLINE' ? 'var(--success)' : cur?.health === 'DEGRADED' ? 'var(--warning)' : 'var(--danger)';
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {cur && <span style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor, flexShrink: 0, display: 'inline-block' }} />}
        <select
          value={selected}
          onChange={e => onSelect(e.target.value)}
          style={{
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius)', padding: '4px 28px 4px 10px',
            fontSize: 12, fontFamily: 'var(--font-mono)', fontWeight: 600,
            color: 'var(--accent)', cursor: 'pointer', outline: 'none', height: 30,
          }}
        >
          {pools.map(p => (
            <option key={p.name} value={p.name}>{p.name} [{p.health}]</option>
          ))}
        </select>
      </div>
    );
  }

  // Pill buttons for 2–4 pools
  return (
    <div style={{
      display: 'flex', background: 'var(--bg-elevated)',
      border: '1px solid var(--border)', borderRadius: 'var(--radius)',
      overflow: 'hidden',
    }}>
      {pools.map(p => {
        const active = selected === p.name;
        const isOnline = p.health === 'ONLINE';
        const isDegraded = p.health === 'DEGRADED';
        const dotColor = isOnline ? 'var(--success)' : isDegraded ? 'var(--warning)' : 'var(--danger)';
        return (
          <button
            key={p.name}
            onClick={() => onSelect(p.name)}
            style={{
              height: 30, padding: '0 14px',
              fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 600,
              letterSpacing: '0.04em',
              background: active ? 'var(--accent-dim)' : 'transparent',
              color: active ? 'var(--accent)' : 'var(--text-muted)',
              cursor: 'pointer', transition: 'all 0.12s',
              border: 'none',
              borderBottomWidth: 2, borderBottomStyle: 'solid',
              borderBottomColor: active ? 'var(--accent)' : 'transparent',
              borderRight: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <span style={{
              width: 5, height: 5, borderRadius: '50%',
              background: dotColor,
              display: 'inline-block', flexShrink: 0,
            }} />
            {p.name}
          </button>
        );
      })}
    </div>
  );
}

/* ── Capacity warning banner ── */
function CapacityBanner({ pool, daysUntilFull }: { pool: ZFSPool; daysUntilFull: number | null }) {
  const pct      = pool.cap;
  const isCrit   = pct >= 95;
  const isDanger = pct >= 90;
  const color    = isCrit || isDanger ? 'var(--danger)' : 'var(--warning)';
  const bg       = isCrit || isDanger ? 'rgba(239,68,68,0.07)' : 'rgba(245,158,11,0.07)';
  const border   = isCrit || isDanger ? 'rgba(239,68,68,0.25)' : 'rgba(245,158,11,0.25)';
  const daysStr  = daysUntilFull !== null && daysUntilFull < 365
    ? ` · ${fmtDays(daysUntilFull)} at current rate` : '';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', marginBottom: 8, background: bg, border: `1px solid ${border}`, borderRadius: 'var(--radius)' }}>
      <AlertTriangle size={14} style={{ color, flexShrink: 0 }} />
      <span style={{ fontSize: 13, color, fontFamily: 'var(--font-ui)', fontWeight: 500, flex: 1 }}>
        {isCrit
          ? `CRITICAL: Pool "${pool.name}" at ${pct}% — ZFS may become read-only.${daysStr}`
          : isDanger
          ? `Pool "${pool.name}" at ${pct}% — ZFS performance degrades above 80%${daysStr}`
          : `Pool "${pool.name}" is at ${pct}% — consider freeing space${daysStr}`}
      </span>
      <a
        href="/pools"
        onClick={e => { e.preventDefault(); window.location.href = '/pools'; }}
        style={{ fontSize: 11, color, fontFamily: 'var(--font-ui)', fontWeight: 600, whiteSpace: 'nowrap', textDecoration: 'underline', opacity: 0.8 }}
      >
        Manage Pool →
      </a>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color, opacity: 0.6 }}>
        {pool.alloc} / {pool.size}
      </span>
    </div>
  );
}

/* ── Stat card ── */
function StatCard({ label, value, sub, fillLine, icon: Icon, color, minHeight = 130 }: {
  label: string; value: string; sub?: string;
  fillLine?: { text: string; color: string; timeText?: string };
  icon: any; color?: string; minHeight?: number;
}) {
  const c = color || 'var(--accent)';
  return (
    <div style={{
      background: 'var(--bg-surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)', minHeight, position: 'relative',
    }}>
      <div style={{
        position: 'absolute', top: 12, right: 12,
        width: 28, height: 28,
        background: `color-mix(in srgb, ${c} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${c} 25%, transparent)`,
        borderRadius: 'var(--radius)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon size={14} color={c} strokeWidth={1.75} />
      </div>
      <div style={{
        display: 'flex', flexDirection: 'column',
        justifyContent: 'center', alignItems: 'flex-start',
        height: '100%', padding: '0 20px',
      }}>
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 500, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
          {label}
        </span>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 28, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1, letterSpacing: '-0.02em', margin: 0, marginTop: 4 }}>
          {value}
        </div>
        {fillLine && (
          <>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: fillLine.color, marginTop: 3, fontWeight: 500 }}>
              {fillLine.text}
            </div>
            {fillLine.timeText && (
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: fillLine.color, marginTop: 2 }}>
                {fillLine.timeText}
              </div>
            )}
          </>
        )}
        {sub && <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--text-muted)', marginTop: fillLine ? 2 : 3 }}>{sub}</div>}
      </div>
    </div>
  );
}

/* ── Rewrite helpers (used in PoolCard) ── */
function fmtBytesDash(b: number): string {
  return formatBytes(b);
}

function fmtSecsDash(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return [h, m, sec].map(v => String(v).padStart(2, '0')).join(':');
}

interface RewriteEntryDash { name: string; pool: string; total_bytes: number; processed_bytes: number; elapsed_secs: number; speed_bps?: number; }

function computeRewriteDash(r: RewriteEntryDash) {
  const total = r.total_bytes;
  const done  = r.processed_bytes;
  const pct   = total > 0 ? Math.min((done / total) * 100, 100) : 0;
  const speedBps = r.speed_bps ?? (r.elapsed_secs > 0 ? done / r.elapsed_secs : 100 * 1024 * 1024);
  const remS  = speedBps > 0 ? Math.max(total - done, 0) / speedBps : 0;
  const speedStr = formatSpeed(speedBps);
  return { pct, label: `Rewriting: ${fmtBytesDash(done)} / ${fmtBytesDash(total)} at ${speedStr}, ${pct.toFixed(2)}% done, ${fmtSecsDash(remS)} to go` };
}

/* ── Pool card ── */
function PoolCard({ pool, fillInfo }: { pool: ZFSPool; fillInfo?: PoolFillInfo }) {
  const daysUntilFull = fillInfo && fillInfo.days > 0 ? fillInfo.days : null;
  const animCap  = useCounter(pool.cap);
  const isOnline = pool.health === 'ONLINE';
  const capColor = pool.cap > 90 ? 'var(--danger)' : pool.cap > 80 ? 'var(--warning)' : 'var(--success)';

  const [scrubState,  setScrubState]  = useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [scrubProg,   setScrubProg]   = useState<{ progress: number; timeRemaining: string; isResilver: boolean; scanDetail: string; scanSpeed: string }>({ progress: 0, timeRemaining: '', isResilver: false, scanDetail: '', scanSpeed: '' });
  const [expansionProg, setExpansionProg] = useState<{ inProgress: boolean; vdev: string; progress: number; eta: string; detail: string } | null>(null);
  const [rewriteActive, setRewriteActive] = useState<RewriteEntryDash[]>([]);
  const [showSnap,    setShowSnap]    = useState(false);
  const [snapName,    setSnapName]    = useState('');
  const [snapError,   setSnapError]   = useState('');
  const [snapWorking, setSnapWorking] = useState(false);
  const [cardToast,   setCardToast]   = useState('');
  const [confirmState, setConfirmState] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);
  const pollRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const popRef    = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getScrubStatus(pool.name).then(res => {
      if (res.in_progress) {
        setScrubState('running');
        setScrubProg({ progress: res.progress || 0, timeRemaining: res.time_remaining || '', isResilver: !!(res.is_resilver), scanDetail: res.scan_detail || '', scanSpeed: res.scan_speed || '' });
        startPoll();
      }
      if (res.expansion?.in_progress) {
        setExpansionProg({
          inProgress: true,
          vdev: res.expansion.vdev || '',
          progress: res.expansion.progress || 0,
          eta: res.expansion.eta || '',
          detail: res.expansion.detail || '',
        });
        startPoll();
      }
    }).catch(() => {});
    // Poll active rewrites for this pool
    const pollRew = () => api.getActiveRewrites().then(r => setRewriteActive((r.active || []).filter((e: RewriteEntryDash) => e.pool === pool.name))).catch(() => {});
    pollRew();
    const rewId = setInterval(pollRew, 1000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); clearInterval(rewId); };
  }, [pool.name]);

  useEffect(() => {
    if (!showSnap) return;
    const h = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setShowSnap(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [showSnap]);

  const startPoll = () => {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const res = await api.getScrubStatus(pool.name);
        if (res.in_progress) {
          setScrubProg({ progress: res.progress || 0, timeRemaining: res.time_remaining || '', isResilver: !!(res.is_resilver), scanDetail: res.scan_detail || '', scanSpeed: res.scan_speed || '' });
        }
        if (res.expansion) {
          setExpansionProg(res.expansion.in_progress ? {
            inProgress: true,
            vdev: res.expansion.vdev || '',
            progress: res.expansion.progress || 0,
            eta: res.expansion.eta || '',
            detail: res.expansion.detail || '',
          } : null);
        }
        if (!res.in_progress && !res.expansion?.in_progress) {
          clearInterval(pollRef.current!); pollRef.current = null;
          setScrubState('success');
          setTimeout(() => setScrubState('idle'), 4000);
        }
      } catch {
        clearInterval(pollRef.current!); pollRef.current = null;
        setScrubState('idle');
      }
    }, 1000);
  };

  const handleScrub = async () => {
    if (scrubState === 'running') return;
    setConfirmState({
      title: "Start ZFS Scrub",
      message: `Are you sure you want to start a ZFS scrub on the pool "${pool.name}"? Scrubbing validates the integrity of all data blocks on disks. It can temporarily degrade I/O performance.`,
      onConfirm: async () => {
        setScrubState('running');
        try {
          await api.startScrub(pool.name);
          startPoll();
        } catch {
          setScrubState('error');
          setTimeout(() => setScrubState('idle'), 3000);
        }
      }
    });
  };

  const openSnapshot = () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    setSnapName(`${pool.name}@${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`);
    setSnapError(''); setShowSnap(true);
  };

  const handleCreateSnapshot = async () => {
    setSnapWorking(true); setSnapError('');
    try {
      await api.createSnapshot(snapName);
      setCardToast('Snapshot created'); setShowSnap(false);
      setTimeout(() => setCardToast(''), 3000);
    } catch (err: any) {
      setSnapError(err.message || 'Failed to create snapshot');
    } finally { setSnapWorking(false); }
  };

  return (
    <div style={{
      background: 'var(--bg-surface)',
      border: `1px solid ${isOnline ? 'var(--border)' : 'rgba(239,68,68,0.3)'}`,
      borderRadius: 'var(--radius-lg)', padding: '20px 22px', position: 'relative',
    }}>
      {cardToast && (
        <div style={{
          position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--success-dim)', border: '1px solid rgba(34,197,94,0.3)',
          borderRadius: 'var(--radius)', padding: '5px 12px',
          fontFamily: 'var(--font-ui)', fontSize: 12, color: 'var(--success)',
          whiteSpace: 'nowrap', zIndex: 10,
        }}>
          {cardToast}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18 }}>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
            {pool.name}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-ui)', marginTop: 2 }}>
            {(pool as any).dedup || '1.00x'} dedup · {(pool as any).frag ?? 0}% frag
          </div>
        </div>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '3px 9px', borderRadius: 9999,
          border: `1px solid ${isOnline ? 'rgba(34,197,94,0.22)' : 'rgba(239,68,68,0.25)'}`,
          background: isOnline ? 'var(--success-dim)' : 'var(--danger-dim)',
          fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600,
          color: isOnline ? 'var(--success)' : 'var(--danger)',
        }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: isOnline ? 'var(--success)' : 'var(--danger)', display: 'inline-block' }} />
          {pool.health}
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)' }}>Storage usage</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: capColor, fontWeight: 600 }}>
            {animCap.toFixed(0)}%
          </span>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${Math.min(pool.cap, 100)}%`, background: capColor }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>{pool.alloc} used</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>{pool.free} free of {pool.size}</span>
        </div>
      </div>

      {fillInfo && (
        <div style={{
          fontSize: 11, fontFamily: 'var(--font-ui)', marginBottom: 14,
          color: fillInfo.color,
          display: 'flex', gap: 8, flexWrap: 'wrap',
        }}>
          {fillInfo.fillDate === 'Shrinking – not filling' ? (
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
              ↓ Shrinking – not filling
            </span>
          ) : fillInfo.fillDate === 'Stable' ? (
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
              — Stable
            </span>
          ) : fillInfo.rateGbDay > 0 ? (
            <>
              <span>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                  +{formatBytes(fillInfo.rateGbDay * 1_073_741_824)}/day
                </span>
              </span>
              {daysUntilFull !== null && (
                <span>
                  · Full in <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{fmtDays(daysUntilFull)}</span>
                </span>
              )}
            </>
          ) : null}
        </div>
      )}

      {scrubState === 'running' && (
        scrubProg.isResilver ? (
          <div style={{ marginBottom: 16, padding: '10px 14px', background: 'rgba(20,184,166,0.04)', borderRadius: 'var(--radius)', border: '1px solid rgba(20,184,166,0.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--success)', fontFamily: 'var(--font-ui)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', border: '1.5px solid rgba(255,255,255,0.2)', borderTopColor: 'var(--success)', animation: 'spin 0.7s linear infinite' }} /> Resilvering
              </span>
              <span style={{ fontSize: 11, color: 'var(--success)', fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{scrubProg.progress.toFixed(2)}%</span>
            </div>
            <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 9999, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${scrubProg.progress}%`, background: 'var(--success)', borderRadius: 9999, transition: 'width 0.5s' }} />
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 4 }}>
              Resilvering: {scrubProg.progress.toFixed(2)}% done{scrubProg.timeRemaining ? `, ${scrubProg.timeRemaining} to go` : ''}{scrubProg.scanSpeed ? ` at ${scrubProg.scanSpeed}` : ''}
            </div>
          </div>
        ) : (
          <div style={{ marginBottom: 16, padding: '10px 14px', background: 'rgba(245,158,11,0.04)', borderRadius: 'var(--radius)', border: '1px solid rgba(245,158,11,0.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--warning)', fontFamily: 'var(--font-ui)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', border: '1.5px solid rgba(255,255,255,0.2)', borderTopColor: 'var(--warning)', animation: 'spin 0.7s linear infinite' }} /> Scrubbing
              </span>
              <div style={{ display: 'flex', gap: 12, fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                {scrubProg.timeRemaining && <span style={{ color: 'var(--text-muted)' }}>{scrubProg.timeRemaining} rem</span>}
                <span style={{ color: 'var(--warning)', fontWeight: 700 }}>{scrubProg.progress.toFixed(1)}%</span>
              </div>
            </div>
            <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 9999, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${scrubProg.progress}%`, background: 'var(--warning)', borderRadius: 9999, transition: 'width 0.5s' }} />
            </div>
          </div>
        )
      )}

      {rewriteActive.map(r => {
        const { pct, label } = computeRewriteDash(r);
        return (
          <div key={r.name} style={{ marginBottom: 16, padding: '10px 14px', background: 'rgba(56,189,248,0.04)', borderRadius: 'var(--radius)', border: '1px solid rgba(56,189,248,0.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--info)', fontFamily: 'var(--font-ui)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', border: '1.5px solid rgba(255,255,255,0.2)', borderTopColor: 'var(--info)', animation: 'spin 0.7s linear infinite' }} /> Rewriting
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

      {expansionProg?.inProgress && (
        <div style={{ marginBottom: 16, padding: '10px 14px', background: 'rgba(99,102,241,0.06)', borderRadius: 'var(--radius)', border: '1px solid rgba(99,102,241,0.2)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--accent)', fontFamily: 'var(--font-ui)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', border: '1.5px solid rgba(255,255,255,0.2)', borderTopColor: 'var(--accent)', animation: 'spin 0.7s linear infinite' }} /> Expanding {expansionProg.vdev}
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

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 14, borderTop: '1px solid var(--border)', position: 'relative' }}>
        <button
          className="btn btn-secondary"
          style={{ height: 26, padding: '0 10px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, opacity: scrubState === 'running' ? 0.65 : 1 }}
          onClick={handleScrub}
          disabled={scrubState === 'running'}
        >
          {scrubState === 'running' && (
            <div style={{ width: 10, height: 10, borderRadius: '50%', border: '1.5px solid rgba(255,255,255,0.2)', borderTopColor: 'currentColor', animation: 'spin 0.7s linear infinite' }} />
          )}
          {scrubState === 'running' ? 'Scrubbing…' : scrubState === 'success' ? 'Done ✓' : 'Scrub'}
        </button>

        <div style={{ position: 'relative' }} ref={popRef}>
          <button
            className="btn btn-secondary"
            style={{ height: 26, padding: '0 10px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}
            onClick={openSnapshot}
          >
            <Camera size={11} /> Snapshot
          </button>
          {showSnap && (
            <div style={{
              position: 'absolute', bottom: 32, right: 0, zIndex: 20,
              width: 260,
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-lg)', padding: 16,
              boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
            }}>
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 10 }}>
                New Snapshot
              </div>
              <input
                value={snapName}
                onChange={e => setSnapName(e.target.value)}
                autoFocus
                style={{
                  width: '100%', height: 32, padding: '0 10px',
                  background: 'var(--bg-base)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)', color: 'var(--text-primary)',
                  fontFamily: 'var(--font-mono)', fontSize: 11, outline: 'none',
                  boxSizing: 'border-box', marginBottom: snapError ? 6 : 12,
                }}
                onKeyDown={e => { if (e.key === 'Enter') handleCreateSnapshot(); if (e.key === 'Escape') setShowSnap(false); }}
              />
              {snapError && (
                <div style={{ fontSize: 11, color: 'var(--danger)', fontFamily: 'var(--font-ui)', marginBottom: 8 }}>{snapError}</div>
              )}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  className="btn btn-primary"
                  style={{ flex: 1, height: 28, fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                  onClick={handleCreateSnapshot}
                  disabled={snapWorking || !snapName.trim()}
                >
                  {snapWorking && <div style={{ width: 10, height: 10, borderRadius: '50%', border: '1.5px solid rgba(255,255,255,0.2)', borderTopColor: '#fff', animation: 'spin 0.7s linear infinite' }} />}
                  {snapWorking ? 'Creating…' : 'Create'}
                </button>
                <button
                  onClick={() => setShowSnap(false)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-ui)', padding: '0 4px' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

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
  );
}

/* ── Log row ── */
function LogRow({ log }: { log: ZFSLog }) {
  const cfg = {
    error:   { label: 'ERR', color: 'var(--danger)',  bg: 'var(--danger-dim)',  border: 'rgba(239,68,68,0.22)'  },
    warning: { label: 'WRN', color: 'var(--warning)', bg: 'var(--warning-dim)', border: 'rgba(245,158,11,0.22)' },
    info:    { label: 'INF', color: 'var(--info)',    bg: 'var(--info-dim)',    border: 'rgba(56,189,248,0.18)' },
  }[log.level] || { label: 'LOG', color: 'var(--text-muted)', bg: 'transparent', border: 'var(--border)' };

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{
        flexShrink: 0, marginTop: 1, width: 36, height: 18,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: cfg.bg, border: `1px solid ${cfg.border}`, borderRadius: 3,
        fontSize: 9, fontFamily: 'var(--font-mono)', fontWeight: 700,
        color: cfg.color, letterSpacing: '0.04em',
      }}>
        {cfg.label}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {log.message}
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
          {log.timestamp}
          {log.pool && <span style={{ marginLeft: 8, color: 'var(--accent)', opacity: 0.7 }}>{log.pool}</span>}
        </div>
      </div>
    </div>
  );
}

/* ── Panel wrapper ── */
function Panel({ title, sub, right, children, style }: {
  title?: string; sub?: string; right?: React.ReactNode;
  children: React.ReactNode; style?: React.CSSProperties;
}) {
  return (
    <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden', ...style }}>
      {title && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid var(--border)' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
            {sub && <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
          </div>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

/* ── Skeleton ── */
function Skeleton({ height = 120 }: { height?: number }) {
  return <div className="skeleton" style={{ height, borderRadius: 'var(--radius-lg)' }} />;
}

/* ── Widget label map ── */
const WIDGET_LABELS: Record<string, string> = {
  'stats-row':        'Stats Row',
  'io-activity':      'I/O Activity',
  'disk-io':          'Physical Disks',
  'pool-cards':       'Pool Cards',
  'system-resources': 'System Resources',
  'activity-log':     'Activity Log',
};

/* ── Module-level caches to persist data across mounts ── */
const dashboardHistData1dCache: { data: any[] } = { data: [] };
const dashboardHistData7dCache: { data: any[] } = { data: [] };
const dashboardDiskMetricsCache: { data: Record<string, any[]> } = { data: {} };

/* ── Main Dashboard ── */
export default function Dashboard({
  pools, datasets, snapshots,
  totalCapacity, totalUsedStorage, totalRawCapacity = 0, totalRawUsed = 0,
  currentStats, liveMetrics, systemStats, logs = [], loading,
  historicalStats = [],
  selectedPool,
  onSelectPool,
}: DashboardProps) {
  const isMobile = useIsMobile();
  const { widgets, loaded, setVisible, reorder, toast, save } = useLayout('dashboard');
  const [editMode, setEditMode] = useState(false);
  const [dragFrom, setDragFrom] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [activeModules, setActiveModules] = useState<ActiveModule[]>([]);
  const [showAddModuleModal, setShowAddModuleModal] = useState(false);

  useEffect(() => {
    getActiveModulesCached().then(res => setActiveModules(res.modules || [])).catch(() => {});
  }, []);

  const [histData1d, setHistData1d] = useState<any[]>(() => dashboardHistData1dCache.data);
  const [histData7d, setHistData7d] = useState<any[]>(() => dashboardHistData7dCache.data);
  const [scrubLive,  setScrubLive]  = useState<Record<string, any>>({});
  const [diskMetrics, setDiskMetrics] = useState<Record<string, any[]>>(() => dashboardDiskMetricsCache.data);
  const [diskPools,   setDiskPools]   = useState<string[]>([]);
  const [ioShowRead,  setIoShowRead]  = useState(true);
  const [ioShowWrite, setIoShowWrite] = useState(true);

  // Multi-pool: resolve the effective selected pool
  const multiPool = pools.length > 1;
  const effectivePoolName = multiPool
    ? (selectedPool && pools.some(p => p.name === selectedPool) ? selectedPool : pools[0]?.name || '')
    : (pools[0]?.name || '');
  const selPool = pools.find(p => p.name === effectivePoolName) || pools[0] || null;

  // Per-pool derived values — when multiPool, show selected pool's stats
  const selCapacity    = multiPool && selPool ? (selPool.used_bytes + selPool.available_bytes) : totalCapacity;
  const selUsedStorage = multiPool && selPool ? selPool.used_bytes : totalUsedStorage;
  const selAvailBytes  = multiPool && selPool ? selPool.available_bytes : pools.reduce((s, p) => s + (p.available_bytes || 0), 0);
  const selUsedBytes   = multiPool && selPool ? selPool.used_bytes : pools.reduce((s, p) => s + (p.used_bytes || 0), 0);
  const selRawCap      = multiPool && selPool ? (Number((selPool as any)._raw?.size)  || 0) : totalRawCapacity;
  const selRawUsed     = multiPool && selPool ? (Number((selPool as any)._raw?.alloc) || 0) : totalRawUsed;

  const usagePct = selCapacity > 0 ? (selUsedStorage / selCapacity) * 100 : 0;
  const animPct  = useCounter(usagePct);
  const cpuLoad  = systemStats?.cpu_load?.[0] ?? currentStats.cpu ?? 0;
  const cpuPct   = typeof cpuLoad === 'number' && cpuLoad <= 1 ? cpuLoad * 100 : cpuLoad;
  const arcHit   = systemStats?.arc_hit_ratio ?? currentStats.arcHit ?? 0;
  const memTotal = systemStats?.memory?.total ?? 0;
  const memUsed  = systemStats?.memory?.used ?? 0;
  const memPct   = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;
  const uptime   = systemStats?.uptime ?? '—';

  // Health for selected pool (or aggregate)
  const selAllOnline = multiPool && selPool ? selPool.health === 'ONLINE' : (pools.length > 0 && pools.every(p => p.health === 'ONLINE'));
  const selHealthLabel = multiPool && selPool
    ? (selPool.health === 'ONLINE' ? 'Healthy' : selPool.health)
    : (pools.length === 0 ? 'No pools' : selAllOnline ? 'Healthy' : 'Degraded');
  const selHealthSub = multiPool && selPool
    ? (selPool.health === 'ONLINE' ? 'ONLINE' : `${selPool.health}`)
    : (pools.length === 0 ? 'Add a pool to get started' : selAllOnline ? `${pools.length}/${pools.length} online` : `${pools.filter(p => p.health !== 'ONLINE').length} need attention`);
  const selHealthColor = multiPool && selPool
    ? (selPool.health === 'ONLINE' ? 'var(--success)' : 'var(--danger)')
    : (pools.length === 0 ? 'var(--text-muted)' : selAllOnline ? 'var(--success)' : 'var(--danger)');

  // Dataset count filtered by pool
  const selDatasets = multiPool && effectivePoolName
    ? datasets.filter(d => d.id === effectivePoolName || d.id.startsWith(effectivePoolName + '/'))
    : datasets;
  const selSnapshots = multiPool && effectivePoolName
    ? snapshots.filter(s => (s.name || '').startsWith(effectivePoolName + '/') || (s.name || '').startsWith(effectivePoolName + '@'))
    : snapshots;

  const pctFree = selAvailBytes > 0
    ? (selAvailBytes / (selAvailBytes + selUsedBytes)) * 100
    : 0;

  const rawPct = selRawCap > 0 ? (selRawUsed / selRawCap) * 100 : 0;

  // Fill prediction from shared backend endpoint
  const { prediction: fillPrediction, byPool: fillByPool } = useFillPrediction();

  useEffect(() => {
    const fetchChartData = () => {
      api.getMetricsHistory('1d').then(res => {
        const seen = new Map<string, any>();
        for (const m of (res.metrics || [])) {
          if (!seen.has(m.collected_at)) {
            seen.set(m.collected_at, {
              timestamp: new Date(m.collected_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }),
              read: m.read_bw_mb, write: m.write_bw_mb, alloc: m.alloc_gb,
            });
          }
        }
        const data = Array.from(seen.values());
        setHistData1d(data);
        dashboardHistData1dCache.data = data;
      }).catch(() => {});

      api.getMetricsHistory('1w').then(res => {
        const seen = new Map<string, any>();
        for (const m of (res.metrics || [])) {
          if (!seen.has(m.collected_at)) {
            seen.set(m.collected_at, { write: m.write_bw_mb });
          }
        }
        const data = Array.from(seen.values());
        setHistData7d(data);
        dashboardHistData7dCache.data = data;
      }).catch(() => {});
    };

    fetchChartData();
    const id = setInterval(fetchChartData, 10_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (pools.length === 0) return;
    const poll = () => {
      pools.forEach(pool => {
        api.getScrubStatus(pool.name).then(res => {
          setScrubLive(prev => ({
            ...prev,
            [pool.name]: {
              inProgress: !!(res.in_progress),
              progress: res.progress || 0,
              timeRemaining: res.time_remaining || '',
              isResilver: !!(res.is_resilver),
              expansionInProgress: !!(res.expansion?.in_progress),
              expansionVdev: res.expansion?.vdev || '',
              expansionProgress: res.expansion?.progress || 0,
              expansionEta: res.expansion?.eta || '',
            },
          }));
        }).catch(() => {});
      });
    };
    poll();
    const id = setInterval(poll, 1000);
    return () => clearInterval(id);
  }, [pools.length]);

  useEffect(() => {
    const names = pools.map(p => p.name).filter(Boolean);
    if (names.length === 0) { setDiskMetrics({}); setDiskPools([]); return; }
    setDiskPools(names);
    const fetchDisks = async () => {
      try {
        const results = await Promise.all(names.map(n => api.getPoolDiskMetrics(n)));
        const map: Record<string, any[]> = {};
        results.forEach((r, i) => { map[names[i]] = r.disks || []; });
        setDiskMetrics(map);
        dashboardDiskMetricsCache.data = map;
      } catch { /* ignore */ }
    };
    fetchDisks();
    const id = setInterval(fetchDisks, 1_000);
    return () => clearInterval(id);
  }, [pools.map(p => p.name).join(',')]);

  const ioData = histData1d.length > 2 ? histData1d : historicalStats;

  // Capacity banners — filter to selected pool when multiPool
  const bannerPools = multiPool && selPool
    ? [selPool].filter(p => p.cap >= 80)
    : [...pools].filter(p => p.cap >= 80).sort((a, b) => b.cap - a.cap);

  // Pool cards to show
  const displayPools = multiPool && selPool ? [selPool] : pools;

  // Disk pools to show in Physical Disks table
  const selDiskPools = multiPool && effectivePoolName ? [effectivePoolName] : diskPools;

  // Per-pool live I/O from disk metrics for the selected pool
  const poolDiskRows = diskMetrics[effectivePoolName] || [];
  const poolLiveRead     = multiPool ? poolDiskRows.reduce((s: number, d: any) => s + (d.read_bw_mb  || 0), 0) : currentStats.read;
  const poolLiveWrite    = multiPool ? poolDiskRows.reduce((s: number, d: any) => s + (d.write_bw_mb || 0), 0) : currentStats.write;
  const poolLiveReadIops = multiPool ? poolDiskRows.reduce((s: number, d: any) => s + (d.read_iops   || 0), 0) : (currentStats.readIops ?? 0);
  const poolLiveWriteIops = multiPool ? poolDiskRows.reduce((s: number, d: any) => s + (d.write_iops || 0), 0) : (currentStats.writeIops ?? 0);

  const handleDragStart = useCallback((id: string) => setDragFrom(id), []);
  const handleDragOver  = useCallback((id: string) => setDragOver(id), []);
  const handleDrop      = useCallback((toId: string) => {
    if (dragFrom && dragFrom !== toId) reorder(dragFrom, toId);
    setDragFrom(null);
    setDragOver(null);
  }, [dragFrom, reorder]);

  const handleRemove = useCallback((id: string) => setVisible(id, false), [setVisible]);
  const handleAdd    = useCallback((id: string) => setVisible(id, true), [setVisible]);

  const sortedWidgets  = [...widgets].sort((a, b) => a.order - b.order);
  const visibleWidgets = sortedWidgets.filter(w => w.visible);

  const renderWidget = (id: string) => {
    switch (id) {
      case 'stats-row':
        return (
          <div className="stats-row-5">
            <StatCard
              label="Total Storage"
              value={formatBytes(selCapacity, 2)}
              sub={`${formatBytes(selUsedStorage, 2)} used · ${rawPct.toFixed(2)}% raw`}
              icon={HardDrive}
              color={usagePct > 90 ? 'var(--danger)' : usagePct > 80 ? 'var(--warning)' : 'var(--accent)'}
            />
            <StatCard
              label="Pool Health"
              value={selHealthLabel}
              sub={selHealthSub}
              icon={ShieldCheck}
              color={selHealthColor}
            />
            <StatCard
              label="Datasets"
              value={String(selDatasets.length)}
              sub={`${selSnapshots.length} snapshot${selSnapshots.length !== 1 ? 's' : ''}`}
              icon={Layers}
              color="var(--info)"
            />
            <StatCard
              label="Used Storage"
              value={formatBytes(selUsedBytes, 2)}
              sub={`Raw (incl. parity): ${formatBytes(selRawUsed, 2)}`}
              icon={Database}
              color={usagePct > 90 ? 'var(--danger)' : usagePct > 80 ? 'var(--warning)' : 'var(--accent)'}
            />
            <StatCard
              label="Available Space"
              value={fmtUsableSpace(selAvailBytes)}
              sub={`${pctFree.toFixed(2)}% free`}
              icon={TrendingUp}
              minHeight={160}
              color={
                fillPrediction?.color === 'var(--danger)'  ? 'var(--danger)'  :
                fillPrediction?.color === 'var(--warning)' ? 'var(--warning)' : 'var(--success)'
              }
            />
          </div>
        );

      case 'disk-io':
        return (
          <Panel title="Physical Disks" sub={`Per-disk I/O · 1 s refresh${multiPool ? ` · ${effectivePoolName}` : ''}`}>
            <PhysicalDisksTable diskPools={selDiskPools} diskMetrics={diskMetrics} />
          </Panel>
        );

      case 'io-activity':
        return (
          <Panel
            title="I/O Activity"
            sub={histData1d.length > 2 ? 'Last 24 hours' : 'Current session · 5s resolution'}
            right={
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => setIoShowRead(v => !v)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    height: 24, padding: '0 8px', borderRadius: 'var(--radius-sm)',
                    border: `1px solid ${ioShowRead ? '#38bdf844' : 'var(--border)'}`,
                    background: ioShowRead ? '#38bdf815' : 'var(--bg-elevated)',
                    color: ioShowRead ? '#38bdf8' : 'var(--text-muted)',
                    fontSize: 10, fontFamily: 'var(--font-mono)', fontWeight: 600,
                    letterSpacing: '0.05em', cursor: 'pointer', transition: 'all 0.12s',
                  }}
                >
                  <ArrowUp size={10} /> Read
                </button>
                <button
                  onClick={() => setIoShowWrite(v => !v)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5,
                    height: 24, padding: '0 8px', borderRadius: 'var(--radius-sm)',
                    border: `1px solid ${ioShowWrite ? '#818cf844' : 'var(--border)'}`,
                    background: ioShowWrite ? '#818cf815' : 'var(--bg-elevated)',
                    color: ioShowWrite ? '#818cf8' : 'var(--text-muted)',
                    fontSize: 10, fontFamily: 'var(--font-mono)', fontWeight: 600,
                    letterSpacing: '0.05em', cursor: 'pointer', transition: 'all 0.12s',
                  }}
                >
                  <ArrowDown size={10} /> Write
                </button>
              </div>
            }
          >
            <div style={{ padding: '16px 20px' }}>
              {ioData.length > 1 ? (
                <>
                  <div style={{ height: isMobile ? 140 : 180, marginLeft: isMobile ? 0 : 8, overflow: 'visible' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={ioData} margin={CHART_MARGIN}>
                        <CartesianGrid {...GRID_PROPS} />
                        <XAxis dataKey="timestamp" axisLine={false} tickLine={false} tick={AXIS_TICK} minTickGap={48} />
                        <YAxis axisLine={false} tickLine={false} tick={AXIS_TICK}
                          tickFormatter={v => formatSpeed(v * 1_048_576)}
                          tickCount={MAX_TICKS}
                          width={85}
                        />
                        <Tooltip {...TOOLTIP_STYLE} formatter={(v: number, n: string) => [
                          formatSpeed(v * 1_048_576),
                          n === 'read' ? '↑ Read' : '↓ Write',
                        ]} />
                        {ioShowRead  && <Line type="monotone" dataKey="read"  stroke="#38bdf8" strokeWidth={1.5} dot={false} isAnimationActive={false} activeDot={{ r: 3, strokeWidth: 0 }} />}
                        {ioShowWrite && <Line type="monotone" dataKey="write" stroke="#818cf8" strokeWidth={1.5} dot={false} isAnimationActive={false} activeDot={{ r: 3, strokeWidth: 0 }} />}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  {(() => {
                    const secsPerPoint = histData1d.length > 2 ? 300 : 1;
                    const totalR = ioData.reduce((s, d) => s + (d.read  || 0), 0) * secsPerPoint;
                    const totalW = ioData.reduce((s, d) => s + (d.write || 0), 0) * secsPerPoint;
                    const peakW  = ioData.reduce((m, d) => Math.max(m, d.write || 0), 0);
                    const fmtData = (v: number) => formatBytes(v * 1_048_576);
                    const fmtBwLocal = (v: number) => formatSpeed(v * 1_048_576);
                    return (
                      <div style={{ display: 'flex', gap: 32, marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                        {[
                          { label: '↑ Read total',  value: fmtData(totalR), color: '#38bdf8' },
                          { label: '↓ Write total', value: fmtData(totalW), color: '#818cf8' },
                          { label: 'Peak write',    value: fmtBwLocal(peakW),       color: 'var(--text-muted)' },
                        ].map(({ label, value, color }) => (
                          <div key={label}>
                            <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-ui)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>{label}</div>
                            <div style={{ fontSize: 13, fontFamily: 'var(--font-mono)', color, fontWeight: 600 }}>{value}</div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-ui)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Forecast:</span>
                    {fillPrediction && fillPrediction.text !== '–' && fillPrediction.timeText ? (
                      <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: fillPrediction.color, fontWeight: 600 }}>
                        Full on {fillPrediction.text.replace('Full on ', '')} ({fillPrediction.timeText})
                      </span>
                    ) : (
                      <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>No growth detected</span>
                    )}
                  </div>
                </>
              ) : (
                <div style={{ height: 80, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-ui)' }}>Collecting I/O data…</span>
                </div>
              )}
            </div>
          </Panel>
        );

      case 'pool-cards':
        return displayPools.length > 0 ? (
          <div>
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 12 }}>
              Storage Pools
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : displayPools.length === 1 ? '1fr' : displayPools.length === 2 || displayPools.length === 4 ? '1fr 1fr' : 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
              {displayPools.map((pool, i) => <PoolCard key={i} pool={pool} fillInfo={fillByPool[pool.name]} />)}
            </div>
          </div>
        ) : null;

      case 'system-resources':
        return (
          <div className="two-col">
            <Panel title="Live I/O" sub={multiPool ? `Pool: ${effectivePoolName} · 1s refresh` : 'Current throughput · 1s refresh'}>
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)' }}>
                {[
                  { label: '↑ Read',       value: fmtBw(poolLiveRead),      color: '#38bdf8' },
                  { label: '↓ Write',      value: fmtBw(poolLiveWrite),     color: '#818cf8' },
                  { label: '↑ IOPS Read',  value: `${poolLiveReadIops.toFixed(0)}`,  sub: 'ops/s', color: '#38bdf8' },
                  { label: '↓ IOPS Write', value: `${poolLiveWriteIops.toFixed(0)}`, sub: 'ops/s', color: '#818cf8' },
                ].map(({ label, value, color, sub }: any, i) => (
                  <div key={label} style={{ padding: isMobile ? '12px 10px' : '16px 18px', borderRight: isMobile ? (i % 2 === 0 ? '1px solid var(--border)' : 'none') : (i < 3 ? '1px solid var(--border)' : 'none'), borderBottom: isMobile && i < 2 ? '1px solid var(--border)' : 'none' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 8 }}>
                      <span style={{ width: 5, height: 5, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }} />
                      <span style={{ fontFamily: 'var(--font-ui)', fontSize: isMobile ? 10 : 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>{label}</span>
                    </div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: isMobile ? 16 : 22, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1, letterSpacing: '-0.02em' }}>
                      {value}{sub && <span style={{ fontSize: isMobile ? 10 : 12, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 3 }}>{sub}</span>}
                    </div>
                  </div>
                ))}
              </div>
              {(() => {
                const totalReadMb  = liveMetrics?.total_read_mb  ?? 0;
                const totalWriteMb = liveMetrics?.total_write_mb ?? 0;
                const selFill = fillByPool[effectivePoolName];
                if (totalReadMb === 0 && totalWriteMb === 0 && !selFill) return null;
                return (
                  <div style={{ borderTop: '1px solid var(--border)', padding: '10px 18px', display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center' }}>
                    {totalReadMb > 0 && (
                      <span style={{ fontSize: 11, fontFamily: 'var(--font-ui)', color: 'var(--text-muted)' }}>
                        Total ↑ <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: '#38bdf8' }}>{fmtGB(totalReadMb / 1024)}</span>
                      </span>
                    )}
                    {totalWriteMb > 0 && (
                      <span style={{ fontSize: 11, fontFamily: 'var(--font-ui)', color: 'var(--text-muted)' }}>
                        Total ↓ <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: '#818cf8' }}>{fmtGB(totalWriteMb / 1024)}</span>
                      </span>
                    )}
                    {selFill && selFill.rateGbDay > 0 && selFill.days > 0 && (
                      <span style={{ fontSize: 11, fontFamily: 'var(--font-ui)', color: 'var(--text-muted)', marginLeft: 'auto' }}>
                        Est. full in <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: selFill.color }}>{fmtDays(selFill.days)}</span>
                      </span>
                    )}
                  </div>
                );
              })()}
            </Panel>

            <Panel title="System Resources">
              <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                {[
                  { label: 'CPU',    pct: cpuPct, value: `${cpuPct.toFixed(1)}%`,  color: cpuPct > 80 ? 'var(--danger)' : 'var(--accent)' },
                  { label: 'Memory', pct: memPct, value: memTotal ? `${formatBytes(memUsed, 2)} / ${formatBytes(memTotal, 2)}` : '—', color: memPct > 85 ? 'var(--danger)' : 'var(--info)' },
                  { label: 'ARC Hit', pct: arcHit, value: `${arcHit.toFixed(1)}%`, color: 'var(--success)' },
                ].map(({ label, pct, value, color }) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', width: isMobile ? 44 : 64, flexShrink: 0 }}>{label}</div>
                    <div className="progress-track" style={{ flex: 1 }}>
                      <div className="progress-fill" style={{ width: `${Math.min(pct, 100)}%`, background: color }} />
                    </div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: isMobile ? 10 : 11, color: 'var(--text-secondary)', width: isMobile ? 72 : 96, textAlign: 'right', flexShrink: 0 }}>{value}</div>
                  </div>
                ))}

                {systemStats?.arc_size > 0 && (
                  <div style={{ marginTop: 8, paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                      <span style={{ fontFamily: 'var(--font-ui)', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>ARC Breakdown</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)' }}>
                        {formatBytes(systemStats.arc_size)} / {formatBytes(systemStats.arc_target || 0)}
                      </span>
                    </div>
                    <div className="progress-track" style={{ display: 'flex', overflow: 'hidden' }}>
                      <div style={{ width: `${(systemStats.arc_data / systemStats.arc_target) * 100}%`, height: '100%', background: '#3b82f6', transition: 'width 0.3s ease' }} title="Data" />
                      <div style={{ width: `${(systemStats.arc_metadata / systemStats.arc_target) * 100}%`, height: '100%', background: '#a855f7', transition: 'width 0.3s ease' }} title="Metadata" />
                    </div>
                    <div style={{ display: 'flex', gap: 12, marginTop: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#3b82f6' }} />
                        <span style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-ui)' }}>Data: {formatBytes(systemStats.arc_data)}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#a855f7' }} />
                        <span style={{ fontSize: 9, color: 'var(--text-muted)', fontFamily: 'var(--font-ui)' }}>Meta: {formatBytes(systemStats.arc_metadata)}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </Panel>
          </div>
        );

      case 'activity-log': {
        const scrubEntries  = Object.entries(scrubLive).filter(([, s]) => s.inProgress);
        const expandEntries = Object.entries(scrubLive).filter(([, s]) => s.expansionInProgress);
        const liveCount = scrubEntries.length + expandEntries.length;
        const totalEvents = liveCount + logs.length;
        return totalEvents > 0 ? (
          <Panel
            title="Recent Activity"
            right={<span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{totalEvents} events</span>}
          >
            <div style={{ padding: '0 20px', maxHeight: 280, overflowY: 'auto' }} className="no-scrollbar">
              {scrubEntries.map(([poolName, s]) => (
                <div key={`scrub-${poolName}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                  <div style={{
                    flexShrink: 0, marginTop: 1, width: 36, height: 18,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'var(--accent-dim)', border: '1px solid var(--accent-mid)', borderRadius: 3,
                    fontSize: 9, fontFamily: 'var(--font-mono)', fontWeight: 700,
                    color: 'var(--accent)', letterSpacing: '0.04em',
                  }}>
                    <span className="live-dot" style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--accent)', display: 'inline-block', marginRight: 3 }} />
                    RUN
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--accent)' }}>
                      {s.isResilver ? 'Resilvering' : 'Scrubbing'} {poolName} — {s.progress.toFixed(1)}% complete{s.timeRemaining ? ` · ${s.timeRemaining} remaining` : ''}
                    </div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                      Live · {poolName}
                    </div>
                  </div>
                </div>
              ))}
              {expandEntries.map(([poolName, s]) => (
                <div key={`expand-${poolName}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                  <div style={{
                    flexShrink: 0, marginTop: 1, width: 36, height: 18,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: 3,
                    fontSize: 9, fontFamily: 'var(--font-mono)', fontWeight: 700,
                    color: 'var(--accent)', letterSpacing: '0.04em',
                  }}>
                    <span className="live-dot" style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--accent)', display: 'inline-block', marginRight: 3 }} />
                    EXP
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--accent)' }}>
                      Expanding {s.expansionVdev} in {poolName} — {s.expansionProgress.toFixed(2)}%{s.expansionEta ? ` · ${s.expansionEta} remaining` : ''}
                    </div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                      Live · {poolName}
                    </div>
                  </div>
                </div>
              ))}
              {logs.slice(0, 20 - liveCount).map((log, i) => <LogRow key={log.id || i} log={log} />)}
            </div>
          </Panel>
        ) : null;
      }

      default: {
        if (id.startsWith('module:')) {
          const parts = id.split(':');
          const modId = parts[1];
          const widgetKey = parts.slice(2).join(':');
          const mod = activeModules.find(m => m.id === modId);
          const wDef = mod?.widget_schema?.find(w => w.key === widgetKey);

          return (
            <Panel title={wDef?.label || widgetKey} sub={mod ? `Modul: ${mod.name}` : `Modul: ${modId}`}>
              <div style={{ padding: '16px 20px' }}>
                <ModuleWidgetRenderer
                  moduleId={modId}
                  widgetKey={widgetKey}
                  widgetType={wDef?.type || 'line'}
                  metrics={wDef?.metrics || [widgetKey]}
                  title={wDef?.label || widgetKey}
                  unit={wDef?.unit}
                  color={wDef?.color || 'var(--accent)'}
                />
              </div>
            </Panel>
          );
        }
        return null;
      }
    }
  };

  return (
    <PageTransition>
    <div style={{ paddingBottom: 48 }}>

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: 20, right: 24, zIndex: 200,
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', padding: '8px 14px',
          fontSize: 12, fontFamily: 'var(--font-ui)', color: 'var(--text-secondary)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        }}>
          {toast}
        </div>
      )}

      {/* Toolbar — pool selector (right) + Edit Layout button */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        {multiPool && onSelectPool && (
          <PoolSelector pools={pools} selected={effectivePoolName} onSelect={onSelectPool} />
        )}
        {!isMobile && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {editMode && (
              <button
                onClick={() => setShowAddModuleModal(true)}
                className="btn btn-secondary"
                style={{ gap: 6 }}
              >
                <Plus size={13} /> Add Module Widget
              </button>
            )}
            <button
              onClick={() => setEditMode(m => !m)}
              className="btn btn-secondary"
              style={{ gap: 6 }}
            >
              {editMode ? <><Check size={13} /> Done</> : <><Edit2 size={13} /> Edit Layout</>}
            </button>
          </div>
        )}
      </div>

      {/* Capacity banners */}
      {bannerPools.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          {bannerPools.map(p => <CapacityBanner key={p.name} pool={p} daysUntilFull={fillByPool[p.name]?.days ?? null} />)}
        </div>
      )}

      {/* Skeleton */}
      {!loaded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Skeleton height={120} /><Skeleton height={220} /><Skeleton height={220} />
        </div>
      )}

      {/* Widget grid */}
      {loaded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {visibleWidgets.map(w => {
            const content = renderWidget(w.id);
            if (!content) return null;
            return (
              <WidgetShell
                key={w.id} id={w.id}
                editMode={editMode}
                onRemove={handleRemove}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                isDragOver={dragOver === w.id && dragFrom !== w.id}
              >
                {content}
              </WidgetShell>
            );
          })}
        </div>
      )}

      {/* Hidden widgets tray (edit mode) */}
      {editMode && (
        <div style={{ marginTop: 24, padding: 24, border: '1px dashed var(--border)', borderRadius: 'var(--radius-lg)', textAlign: 'center' }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 16, color: 'var(--text-secondary)' }}>Hidden Widgets</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'center' }}>
            {widgets.filter(w => !w.visible).map(w => (
              <button key={w.id} className="btn btn-secondary" onClick={() => handleAdd(w.id)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Plus size={14} /> {WIDGET_LABELS[w.id] || w.id}
              </button>
            ))}
            {widgets.every(w => w.visible) && (
              <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>All widgets are currently visible.</p>
            )}
          </div>
        </div>
      )}

      {/* Add Module Widget Modal */}
      <AddModuleWidgetModal
        isOpen={showAddModuleModal}
        onClose={() => setShowAddModuleModal(false)}
        onSelectWidget={(mod, widget) => {
          const widgetId = `module:${mod.id}:${widget.key}`;
          if (widgets.some(w => w.id === widgetId)) {
            setVisible(widgetId, true);
          } else {
            save([...widgets, { id: widgetId, visible: true, order: widgets.length }]);
          }
        }}
      />

      {/* Empty state */}
      {loaded && pools.length === 0 && !loading && (
        <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '64px 32px', textAlign: 'center', marginTop: 16 }}>
          <Database size={40} color="var(--text-muted)" strokeWidth={1} style={{ margin: '0 auto 16px' }} />
          <h3 style={{ fontFamily: 'var(--font-ui)', fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
            No storage pools configured
          </h3>
          <p style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--text-muted)' }}>
            Navigate to Storage Pools to create or import a pool.
          </p>
        </div>
      )}
    </div>
    </PageTransition>
  );
}
