import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Menu, Activity } from 'lucide-react';
import Sidebar, { Breakpoint } from './components/Sidebar';
import Dashboard from './components/Dashboard';
import Performance from './components/Performance';
import StoragePools from './components/StoragePools';
import DatasetList from './components/DatasetList';
import SnapshotManager from './components/SnapshotManager';
import SystemLogs from './components/SystemLogs';
import Login from './components/Login';
import Settings from './components/Settings';
import Notifications from './pages/Notifications';
import ModuleStore from './pages/ModuleStore';
import ActiveModules from './pages/ActiveModules';
import CustomTabPage from './pages/CustomTabPage';
import FileSystemPage from './pages/FileSystemPage';
import DatabasePage from './pages/DatabasePage';
import { ZFSPool, ZFSDataset, ZFSLog } from './types';
import { api, formatBytes, setApiKey } from './api';
import { Bell } from 'lucide-react';
import { NotificationProvider, NotificationCenter, useNotifications } from './context/NotificationContext';

const PAGE_TITLES: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/stats':     'Performance',
  '/pools':     'Storage Pools',
  '/datasets':  'Datasets',
  '/snapshots': 'Snapshots',
  '/store':     'Module Store',
  '/modules':   'Active Modules',
  '/logs':      'System Logs',
  '/notifications': 'Notifications',
  '/settings':  'Settings',
  '/filesystem': 'File System',
  '/database':  'Database',
};

function getBreakpoint(): Breakpoint {
  const w = window.innerWidth;
  if (w < 768)  return 'mobile';
  if (w < 1200) return 'tablet';
  return 'desktop';
}

function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>(getBreakpoint);
  useEffect(() => {
    const h = () => setBp(getBreakpoint());
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  return bp;
}

// ── Log level classifier ─────────────────────────────────────────────────────
function classifyLogLevel(line: string): 'error' | 'warning' | 'info' {
  const lower = line.toLowerCase();
  // Strip timestamp prefix to get the command part
  const cmd = line.replace(/^\d{4}-\d{2}-\d{2}\.\d{2}:\d{2}:\d{2}\s+/, '').trim().toLowerCase();

  // ERROR — pool state problems and real I/O errors
  if (lower.includes('degraded') || lower.includes('faulted') || lower.includes('unavail')) return 'error';
  if (lower.includes('missing') && lower.includes('disk')) return 'error';
  // Scrub finished with read or write errors (not just "0 errors")
  if (lower.includes('scrub') && (
    (/\b[1-9]\d* read errors?\b/i.test(line)) ||
    (/\b[1-9]\d* write errors?\b/i.test(line))
  )) return 'error';
  // Generic error but NOT "0 errors" and NOT routine zfs commands
  if (
    lower.includes('error') &&
    !/\b0 (read |write |data |checksum )?errors?\b/i.test(line) &&
    !cmd.startsWith('zfs ') && !cmd.startsWith('zpool ')
  ) return 'error';

  // WARNING — needs attention but not broken
  if (lower.includes('checksum') && !/\b0 checksum\b/i.test(line)) return 'warning';
  if (lower.includes('resilver') || lower.includes('resilvering')) return 'warning';
  if (lower.includes('warn')) return 'warning';

  // INFO — everything else including zfs destroy, create, rename, successful scrubs
  return 'info';
}

function TopBar({
  loading,
  systemStats,
  onMenuOpen,
  sysNotifications,
  onMarkRead,
  onMarkAllSystemRead,
  onClearAllSystem,
}: {
  loading: boolean;
  systemStats: any;
  onMenuOpen?: () => void;
  sysNotifications: any[];
  onMarkRead: (id: number) => void;
  onMarkAllSystemRead: () => void;
  onClearAllSystem: () => void;
}) {
  const location = useLocation();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const title = PAGE_TITLES[location.pathname] || 'ZFS Dashboard';
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { unreadCount, notifications, notify } = useNotifications();
  const shownSysNotifIds = useRef<Set<number>>(new Set());

  // Bridge unread critical system notifications into the standard toast system
  useEffect(() => {
    for (const item of sysNotifications) {
      if (item.is_read) continue;
      if (item.level !== 'error' && item.level !== 'warning') continue;
      if (shownSysNotifIds.current.has(item.id)) continue;
      shownSysNotifIds.current.add(item.id);
      notify({
        type: item.level === 'error' ? 'error' : 'warning',
        title: item.level === 'error' ? 'System Alert' : 'System Warning',
        message: item.message,
      });
    }
  }, [sysNotifications, notify]);

  const sysUnread = sysNotifications.filter(n => !n.is_read).length;
  const totalUnread = unreadCount + sysUnread;

  useEffect(() => {
    if (!dropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [dropdownOpen]);

  const getBellColor = () => {
    if (totalUnread === 0) return 'var(--text-muted)';
    const hasCritical = notifications.some(n => !n.isRead && (n.type === 'error' || n.type === 'warning'))
      || sysNotifications.some(n => !n.is_read && n.level === 'error');
    const hasWarning = sysNotifications.some(n => !n.is_read && n.level === 'warning');
    if (hasCritical) return 'var(--danger)';
    if (hasWarning) return 'var(--warning)';
    return 'var(--accent)';
  };

  return (
    <header style={{
      height: 52, display: 'flex', alignItems: 'center',
      padding: onMenuOpen ? '0 16px' : '0 24px',
      background: 'var(--bg-surface)',
      borderBottom: '1px solid var(--border)',
      flexShrink: 0, gap: 12,
    }}>
      {onMenuOpen && (
        <button
          onClick={onMenuOpen}
          style={{
            width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: 'var(--text-muted)', borderRadius: 'var(--radius)', flexShrink: 0,
            transition: 'color 0.1s',
          }}
          onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-primary)'}
          onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)'}
        >
          <Menu size={20} />
        </button>
      )}

      <span style={{
        fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 600,
        color: 'var(--text-primary)', letterSpacing: '-0.01em',
        flex: 1, textAlign: onMenuOpen ? 'center' : 'left',
      }}>
        {title}
      </span>

      <div style={{ display: 'flex', alignItems: 'center', gap: onMenuOpen ? 4 : 16 }}>
        <div style={{ position: 'relative' }} ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 32, height: 32, borderRadius: '50%', color: 'var(--text-muted)',
              position: 'relative',
            }}
          >
            <Bell
              size={18}
              style={{ color: getBellColor(), transition: 'color 0.25s ease' }}
            />
            {totalUnread > 0 && (
              <span style={{
                position: 'absolute', top: 2, right: 2, background: 'var(--danger)',
                color: '#fff', fontSize: 9, fontWeight: 700, borderRadius: '50%',
                width: 14, height: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'var(--font-mono)',
              }}>{totalUnread > 99 ? '99+' : totalUnread}</span>
            )}
          </button>
          {dropdownOpen && (
            <NotificationCenter
              onClose={() => setDropdownOpen(false)}
              systemNotifications={sysNotifications}
              onMarkSystemRead={(id) => { onMarkRead(id); }}
              onMarkAllSystemRead={onMarkAllSystemRead}
              onClearAllSystem={onClearAllSystem}
            />
          )}
        </div>
        {!onMenuOpen && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className={loading ? 'dot dot-warning' : 'dot dot-success'} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>
              {loading ? 'Syncing' : 'Live'}
            </span>
          </div>
        )}
      </div>
    </header>
  );
}

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(!!localStorage.getItem('zfs_access_token'));
  const [isDefaultPassword, setIsDefaultPassword] = useState(false);
  const [pools, setPools]           = useState<ZFSPool[]>([]);
  const [datasets, setDatasets]     = useState<ZFSDataset[]>([]);
  const [volumes, setVolumes]       = useState<any[]>([]);
  const [snapshots, setSnapshots]   = useState<any[]>([]);
  const [totalCapacity, setTotalCapacity]       = useState(0);
  const [totalUsedStorage, setTotalUsedStorage] = useState(0);
  const [totalRawCapacity, setTotalRawCapacity] = useState(0);
  const [totalRawUsed, setTotalRawUsed]         = useState(0);
  const [stats, setStats]           = useState<any[]>([]);
  const [liveMetrics, setLiveMetrics] = useState<any>(null);
  const [serverTimeOffsetMs, setServerTimeOffsetMs] = useState(0);
  const [systemStats, setSystemStats] = useState<any>(null);
  const [healthData, setHealthData] = useState<any>(null);
  const [logs, setLogs]             = useState<ZFSLog[]>([]);
  const [sysNotifications, setSysNotifications] = useState<any[]>([]);
  const [loading, setLoading]       = useState(true);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [completedRewrite, setCompletedRewrite] = useState<any | null>(null);
  const [selectedPool, setSelectedPool] = useState<string>(
    () => localStorage.getItem('zfs_default_pool') || ''
  );
  const poolsInitializedRef = useRef(false);

  const breakpoint = useBreakpoint();

  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    const bp = getBreakpoint();
    if (bp === 'desktop') return localStorage.getItem('sidebar_collapsed') === 'true';
    return bp === 'tablet';
  });

  useEffect(() => {
    if (breakpoint === 'tablet') {
      setSidebarCollapsed(true);
    } else if (breakpoint === 'desktop') {
      setSidebarCollapsed(localStorage.getItem('sidebar_collapsed') === 'true');
    } else {
      setMobileSidebarOpen(false);
    }
  }, [breakpoint]);

  const handleToggleCollapse = () => {
    setSidebarCollapsed(v => {
      const next = !v;
      if (breakpoint === 'desktop') localStorage.setItem('sidebar_collapsed', String(next));
      return next;
    });
  };

  const sidebarWidth =
    breakpoint === 'mobile' ? 0 :
    breakpoint === 'tablet' ? 56 :
    sidebarCollapsed ? 56 : 220;

  // ── Login: call api.login(), store token, check isDefaultPassword ──────────
  const handleLogin = async (password: string) => {
    const res = await api.login(password);
    setApiKey(res.token);
    setIsDefaultPassword(res.is_default_password);
    setIsAuthenticated(true);
  };

  // ── Sync selectedPool when pools first load ──────────────────────────────
  useEffect(() => {
    if (pools.length === 0) return;
    const names = pools.map(p => p.name);
    if (!poolsInitializedRef.current || !names.includes(selectedPool)) {
      poolsInitializedRef.current = true;
      const saved = localStorage.getItem('zfs_default_pool') || '';
      const resolved = names.find(n => n === saved) || names[0];
      setSelectedPool(resolved);
    }
  }, [pools]);

  const handleSelectPool = useCallback((name: string) => {
    setSelectedPool(name);
    localStorage.setItem('zfs_default_pool', name);
  }, []);

  // ── Global backend connection health checks ──────────────────────────────
  useEffect(() => {
    const checkConnection = () => {
      api.getHealth()
        .then(() => {
          setGlobalError(null);
        })
        .catch((error: any) => {
          if (error.message?.includes('401') || error.message?.includes('403')) {
            // Backend is up and returned auth error - this is expected if unauthenticated!
            setGlobalError(null);
          } else {
            setGlobalError(`Backend connection failed: ${error.message}`);
          }
        });
    };
    checkConnection();
    const iv = setInterval(checkConnection, 5000);
    return () => clearInterval(iv);
  }, []);

  // ── Fetch server time once on login ──────────────────────────────────────
  useEffect(() => {
    if (!isAuthenticated) return;
    api.getServerTime().then(({ now }) => {
      setServerTimeOffsetMs(new Date(now).getTime() - Date.now());
    }).catch(() => {});
  }, [isAuthenticated]);

  // ── 1s live metrics loop — also feeds session history (replaces getPoolIoStat) ──
  useEffect(() => {
    if (!isAuthenticated) return;
    const iv = setInterval(async () => {
      try {
        const m = await api.getLiveMetrics();
        setLiveMetrics(m);
        const time = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        setStats(prev => [...prev.slice(-299), {
          name: time, timestamp: time,
          read:      m.read_bw_mb,
          write:     m.write_bw_mb,
          iops:      (m.read_iops ?? 0) + (m.write_iops ?? 0),
          readIops:  m.read_iops  ?? 0,
          writeIops: m.write_iops ?? 0,
          cpu:       m.cpu_percent    ?? 0,
          arcHit:    m.arc_hit_ratio  ?? 0,
          alloc: 0, free: 0,
        }]);
      } catch { /* ignore */ }
    }, 1000);
    return () => clearInterval(iv);
  }, [isAuthenticated]);

  // ── Persist default-password flag across F5 ──────────────────────────────
  useEffect(() => {
    if (!isAuthenticated) return;
    api.getMe().then(res => {
      setIsDefaultPassword(res.is_default_password);
    }).catch(() => {});
  }, [isAuthenticated]);

  const fetchData = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const [poolsRes, snapshotRes, statsRes, datasetsRes, volumesRes, healthRes] = await Promise.all([
        api.getPools(),
        api.getSnapshots(),
        api.getSystemStats().catch(() => null),
        api.getDatasets(),
        api.getVolumes(),
        api.getHealth().catch(() => null),
      ]);

      // fetch notifications without throwing
      fetch('/api/v1/notifications', { headers: { 'Authorization': `Bearer ${localStorage.getItem('zfs_access_token')}` } })
        .then(r => r.json())
        .then(n => { if (Array.isArray(n)) setSysNotifications(n); })
        .catch(() => {});

      if (statsRes) setSystemStats(statsRes);
      if (healthRes) setHealthData(healthRes);

      const mappedPools: ZFSPool[] = (poolsRes.pools || []).map((p: any) => {
        const avail = Number(p.available_bytes) || 0;
        const used  = Number(p.used_bytes)      || 0;
        return {
          name: p.name,
          // Use zfs-get available/used (RAID-aware) for displayed capacity.
          size:  formatBytes(avail + used, 2),
          alloc: formatBytes(used,         2),
          free:  formatBytes(avail,        2),
          cap:   parseInt(p.cap)  || 0,
          frag:  parseInt(p.frag) || 0,
          dedup: p.dedup || '1.00x',
          health: p.health,
          raidType: 'ZFS Pool',
          vdevs: [],
          available_bytes: avail,
          used_bytes:      used,
          _raw: p,
        };
      });

      const logicalCap  = mappedPools.reduce((a, p) => a + p.used_bytes + p.available_bytes, 0);
      const logicalUsed = mappedPools.reduce((a, p) => a + p.used_bytes, 0);
      const rawCap      = (poolsRes.pools || []).reduce((a: number, p: any) => a + (Number(p.size)  || 0), 0);
      const rawUsed     = (poolsRes.pools || []).reduce((a: number, p: any) => a + (Number(p.alloc) || 0), 0);

      setPools(mappedPools);
      setTotalCapacity(logicalCap);
      setTotalUsedStorage(logicalUsed);
      setTotalRawCapacity(rawCap);
      setTotalRawUsed(rawUsed);
      setSnapshots(snapshotRes.snapshots || []);

      setDatasets((datasetsRes.datasets || []).map((d: any) => ({
        id: d.name, name: d.name,
        used: formatBytes(d.used, 2),
        avail: formatBytes(d.available || d.avail, 2),
        refer: formatBytes(d.refer, 2),
        mountpoint: d.mountpoint,
        compression: d.compression || 'lz4',
        dedup: d.dedup || 'off',
        readonly: d.readonly === 'on' || d.readonly === true,
        _usedBytes: Number(d.used) || 0,
        _availBytes: Number(d.available || d.avail) || 0,
      })));

      setVolumes((volumesRes.volumes || []).map((v: any) => ({
        ...v,
        used: formatBytes(v.used, 2), avail: formatBytes(v.avail, 2),
        volsize: formatBytes(v.volsize, 2), refer: formatBytes(v.refer, 2),
      })));

      if (mappedPools.length > 0) {
        try {
          const histResults = await Promise.all(
            mappedPools.map(p => api.getPoolHistory(p.name).catch(() => ({ history: [] })))
          );
          const allLogs: ZFSLog[] = [];
          histResults.forEach((histRes, idx) => {
            const poolName = mappedPools[idx].name;
            (histRes.history || [])
              .filter((line: string) => line.trim() && !line.startsWith('History'))
              .slice(-100)
              .forEach((line: string, i: number) => {
                allLogs.push({
                  id: `${poolName}-${i}`,
                  timestamp: line.substring(0, 19) || new Date().toISOString(),
                  level: classifyLogLevel(line),
                  message: line.replace(/^\d{4}-\d{2}-\d{2}\.\d{2}:\d{2}:\d{2}\s+/, '').trim(),
                  pool: poolName,
                });
              });
          });
          allLogs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
          setLogs(allLogs.slice(0, 300));
        } catch { /* no history */ }
      }

      setLoading(false);
      setGlobalError(null);
    } catch (error: any) {
      if (error.message?.includes('401')) {
        localStorage.removeItem('zfs_access_token');
        setIsAuthenticated(false);
      } else {
        setGlobalError(`Backend connection failed: ${error.message}`);
      }
      setLoading(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated) {
      fetchData();
      const pollCompleted = () => {
        api.getCompletedRewrites().then(res => {
          if (res.completed && res.completed.length > 0) {
            setCompletedRewrite(res.completed[0]);
          }
        }).catch(() => {});
      };
      pollCompleted();
      const iv = setInterval(() => {
        fetchData();
        pollCompleted();
      }, 5000);
      return () => clearInterval(iv);
    }
  }, [isAuthenticated, fetchData]);

  const isConnectionIssue = !!(globalError && (
    globalError.toLowerCase().includes('failed') ||
    globalError.toLowerCase().includes('connection') ||
    globalError.toLowerCase().includes('network') ||
    globalError.toLowerCase().includes('refused')
  ));

  if (isConnectionIssue) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: '100vh', width: '100vw', background: 'radial-gradient(circle at center, #18181b, #09090b)',
        color: '#f4f4f5', fontFamily: 'var(--font-ui)'
      }}>
        {/* Animated pulsing ZFS Dashboard loading visual */}
        <div style={{ position: 'relative', width: 80, height: 80, marginBottom: 24 }}>
          <div style={{
            position: 'absolute', inset: 0, borderRadius: '50%',
            border: '2px solid var(--accent)', opacity: 0.1,
            animation: 'ping 2s cubic-bezier(0, 0, 0.2, 1) infinite'
          }} />
          <div style={{
            position: 'absolute', inset: 8, borderRadius: '50%',
            border: '3px solid transparent', borderTopColor: 'var(--accent)',
            animation: 'spin 1s linear infinite'
          }} />
          <div style={{
            position: 'absolute', inset: 16, borderRadius: '50%',
            background: 'var(--accent-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 700, fontSize: '1.2rem', color: 'var(--accent)'
          }}>
            ZFS
          </div>
        </div>

        <h2 style={{ fontSize: '1.5rem', fontWeight: 600, marginBottom: 8, letterSpacing: '-0.02em' }}>
          Starting ZFS Dashboard...
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', maxWidth: 400, textAlign: 'center', lineHeight: 1.5, margin: '0 24px 24px 24px' }}>
          The backend is performing diagnostic checks and preparing ZFS pool mounts. This process completes automatically once ready.
        </p>

        {/* Diagnostic Check List */}
        <div style={{
          width: '100%', maxWidth: 360, background: '#18181b', border: '1px solid var(--border-subtle)',
          borderRadius: 8, padding: 16, display: 'flex', flexDirection: 'column', gap: 10,
          boxShadow: '0 4px 20px rgba(0,0,0,0.3)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.85rem' }}>
            <span style={{ color: 'var(--text-muted)' }}>Infrastructure check</span>
            <span style={{ color: 'var(--warning)', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span className="dot-pulse" /> Pending
            </span>
          </div>
          <div style={{ height: 1, background: 'var(--border-subtle)' }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.85rem' }}>
            <span style={{ color: 'var(--text-muted)' }}>ZFS pool mounts & imports</span>
            <span style={{ color: 'var(--warning)', fontWeight: 500 }}>Pending</span>
          </div>
          <div style={{ height: 1, background: 'var(--border-subtle)' }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.85rem' }}>
            <span style={{ color: 'var(--text-muted)' }}>Database connection</span>
            <span style={{ color: 'var(--warning)', fontWeight: 500 }}>Connecting</span>
          </div>
        </div>

        {/* Retrying label */}
        <div style={{ marginTop: 24, fontSize: '0.8rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="spinner-mini" />
          Retrying connection to backend...
        </div>

        <style>{`
          @keyframes ping {
            75%, 100% { transform: scale(2); opacity: 0; }
          }
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
          .dot-pulse {
            width: 8px; height: 8px; background: var(--warning); border-radius: 50%;
            animation: pulse 1.5s infinite;
          }
          @keyframes pulse {
            0% { transform: scale(0.9); opacity: 0.5; }
            50% { transform: scale(1.1); opacity: 1; }
            100% { transform: scale(0.9); opacity: 0.5; }
          }
          .spinner-mini {
            width: 12px; height: 12px; border: 2px solid transparent;
            border-top-color: var(--text-muted); border-radius: 50%;
            animation: spin 0.8s linear infinite;
          }
        `}</style>
      </div>
    );
  }

  if (!isAuthenticated) return <Login onLogin={handleLogin} />;

  // currentStats: live values from the 1s polling loop, falling back to last stat point
  const currentStats = {
    read:      liveMetrics?.read_bw_mb    ?? stats[stats.length - 1]?.read      ?? 0,
    write:     liveMetrics?.write_bw_mb   ?? stats[stats.length - 1]?.write     ?? 0,
    iops:      ((liveMetrics?.read_iops ?? 0) + (liveMetrics?.write_iops ?? 0)) || stats[stats.length - 1]?.iops || 0,
    readIops:  liveMetrics?.read_iops     ?? stats[stats.length - 1]?.readIops  ?? 0,
    writeIops: liveMetrics?.write_iops    ?? stats[stats.length - 1]?.writeIops ?? 0,
    cpu:       liveMetrics?.cpu_percent   ?? stats[stats.length - 1]?.cpu       ?? 0,
    arcHit:    liveMetrics?.arc_hit_ratio ?? stats[stats.length - 1]?.arcHit    ?? 0,
  };

  return (
    <NotificationProvider>
    <BrowserRouter>
      <div style={{
        display: 'flex', height: '100vh',
        background: 'var(--bg-base)', overflow: 'hidden',
      }}>

        {/* Mobile backdrop */}
        {breakpoint === 'mobile' && mobileSidebarOpen && (
          <div
            onClick={() => setMobileSidebarOpen(false)}
            style={{
              position: 'fixed', inset: 0, zIndex: 99,
              background: 'rgba(0,0,0,0.5)',
            }}
          />
        )}

        {/* Sidebar wrapper */}
        <div style={{
          width: sidebarWidth, flexShrink: 0,
          position: 'relative', height: '100%',
          overflow: 'visible',
          transition: 'width 0.2s ease',
        }}>
          <Sidebar
            systemStats={systemStats}
            healthData={healthData}
            mobileOpen={mobileSidebarOpen}
            onClose={() => setMobileSidebarOpen(false)}
            collapsed={sidebarCollapsed}
            onToggleCollapse={handleToggleCollapse}
            breakpoint={breakpoint}
          />
        </div>

        {/* Main content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          <TopBar
            loading={loading}
            systemStats={systemStats}
            sysNotifications={sysNotifications}
            onMarkRead={(id) => {
              fetch(`/api/v1/notifications/${id}/read`, { method: 'POST', headers: { 'Authorization': `Bearer ${localStorage.getItem('zfs_access_token')}` } });
              setSysNotifications(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n));
            }}
            onMarkAllSystemRead={() => {
              fetch('/api/v1/notifications/read', { method: 'POST', headers: { 'Authorization': `Bearer ${localStorage.getItem('zfs_access_token')}` } });
              setSysNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
            }}
            onClearAllSystem={() => {
              fetch('/api/v1/notifications', { method: 'DELETE', headers: { 'Authorization': `Bearer ${localStorage.getItem('zfs_access_token')}` } });
              setSysNotifications([]);
            }}
            onMenuOpen={breakpoint === 'mobile' ? () => setMobileSidebarOpen(true) : undefined}
          />

          <main
            style={{
              flex: 1, overflowY: 'auto', overflowX: 'hidden',
              padding: breakpoint === 'mobile' ? '16px' : '24px',
            }}
            className="no-scrollbar"
          >
            {globalError && (
              <div style={{
                marginBottom: 24, padding: '12px 16px', borderRadius: 'var(--radius)',
                background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)',
                color: '#ef4444', display: 'flex', alignItems: 'center', gap: 12, fontSize: '0.85rem'
              }}>
                <span style={{ fontWeight: 600 }}>Connection Issue:</span>
                <span>{globalError}</span>
              </div>
            )}

            {/* Default password warning banner */}
            {isDefaultPassword && (
              <div style={{
                marginBottom: 24, padding: '12px 16px', borderRadius: 'var(--radius)',
                background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.3)',
                color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: 12, fontSize: '0.85rem'
              }}>
                <span style={{ fontWeight: 600 }}>Security Warning:</span>
                <span>You are using the default password. Please change it in <a href="/settings" style={{ color: 'var(--warning)', textDecoration: 'underline' }}>Settings</a>.</span>
              </div>
            )}

            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={
                <Dashboard
                  pools={pools} datasets={datasets} snapshots={snapshots}
                  totalCapacity={totalCapacity} totalUsedStorage={totalUsedStorage}
                  totalRawCapacity={totalRawCapacity} totalRawUsed={totalRawUsed}
                  currentStats={currentStats} liveMetrics={liveMetrics}
                  systemStats={systemStats} logs={logs} loading={loading} historicalStats={stats}
                  selectedPool={selectedPool} onSelectPool={handleSelectPool}
                />
              } />
              <Route path="/stats" element={
                <Performance
                  stats={stats} liveMetrics={liveMetrics}
                  serverTimeOffsetMs={serverTimeOffsetMs} pools={pools}
                  selectedPool={selectedPool} onSelectPool={handleSelectPool}
                />
              } />
              <Route path="/pools" element={
                <StoragePools pools={pools} onRefresh={fetchData} zfsVersion={systemStats?.zfs_version} />
              } />
              <Route path="/datasets" element={
                <DatasetList datasets={datasets} volumes={volumes} pools={pools} onRefresh={fetchData} />
              } />
              <Route path="/snapshots" element={
                <SnapshotManager snapshots={snapshots} datasets={datasets} pools={pools} onRefresh={fetchData} selectedPool={selectedPool} onSelectPool={handleSelectPool} />
              } />
              <Route path="/logs" element={<SystemLogs logs={logs} pools={pools} />} />
              <Route path="/settings" element={
                <Settings onPasswordChanged={() => setIsDefaultPassword(false)} pools={pools} selectedPool={selectedPool} onSelectPool={handleSelectPool} />
              } />
              <Route path="/store" element={<ModuleStore />} />
              <Route path="/modules" element={<ActiveModules />} />
              <Route path="/filesystem" element={<FileSystemPage />} />
              <Route path="/database" element={<DatabasePage />} />
              <Route path="/custom/:slug" element={<CustomTabPage />} />
              <Route path="/notifications" element={<Notifications />} />
              <Route path="/login" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </main>
        </div>
      </div>

      {/* Beautiful completed rewrite modal */}
      {completedRewrite && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, backdropFilter: 'blur(4px)', animation: 'fadeIn 0.2s ease-out' }}>
          <div style={{ background: 'var(--bg-surface)', padding: 28, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', maxWidth: 500, width: '90%', boxShadow: '0 20px 50px rgba(0,0,0,0.6)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(56, 189, 248, 0.1)', border: '1px solid rgba(56, 189, 248, 0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--info)' }}>
                <Activity size={20} />
              </div>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>Dataset Rewrite Completed</h3>
            </div>
            
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.5, marginBottom: 20 }}>
              The sequential block rewrite for dataset <strong style={{ color: 'var(--text-primary)' }}>"{completedRewrite.name}"</strong> has finished successfully.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24, padding: 16, background: 'rgba(255,255,255,0.015)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: 'var(--text-muted)' }}>Duration:</span>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', fontWeight: 600 }}>{Math.floor(completedRewrite.duration_secs / 60)}m {completedRewrite.duration_secs % 60}s</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: 'var(--text-muted)' }}>Files Processed:</span>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', fontWeight: 600 }}>{completedRewrite.total_files}</span>
              </div>
              <div style={{ borderTop: '1px solid var(--border)', margin: '8px 0' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: 'var(--text-muted)' }}>Logical Size Before:</span>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', fontWeight: 600 }}>{formatBytes(completedRewrite.size_before_bytes)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: 'var(--text-muted)' }}>Logical Size After:</span>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--success)', fontWeight: 600 }}>{formatBytes(completedRewrite.size_after_bytes)}</span>
              </div>
              <div style={{ borderTop: '1px solid var(--border)', margin: '8px 0' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: 'var(--text-muted)' }}>Block Usage Before (du -s):</span>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', fontWeight: 600 }}>{formatBytes(completedRewrite.du_before_blocks * 1024)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: 'var(--text-muted)' }}>Block Usage After (du -s):</span>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--success)', fontWeight: 600 }}>{formatBytes(completedRewrite.du_after_blocks * 1024)}</span>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-primary" onClick={() => setCompletedRewrite(null)} style={{ padding: '8px 24px', fontSize: 13 }}>
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

    </BrowserRouter>
    </NotificationProvider>
  );
}
