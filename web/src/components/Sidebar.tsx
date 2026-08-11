import React, { useState, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Activity, Database, Layers,
  Camera, FileText, Settings, HardDrive, LogOut,
  Server, ChevronLeft, ChevronRight, Bell,
  Store, Blocks, FolderTree, Terminal,
} from 'lucide-react';

import { api } from '../api';
import { CustomTab } from '../types';
import { getNavLayout, syncCustomTabsToLayout, NavCategory } from '../utils/navStorage';
import { getLatestReleaseCached } from '../utils/moduleCache';

const ICON_MAP: Record<string, React.ComponentType<any>> = {
  LayoutDashboard,
  Activity,
  Database,
  Layers,
  Camera,
  Store,
  Blocks,
  FileText,
  Bell,
  Settings,
  FolderTree,
  Terminal,
};

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

interface SidebarProps {
  systemStats?: any;
  healthData?: any;
  mobileOpen?: boolean;
  onClose?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  breakpoint?: Breakpoint;
}

export default function Sidebar({
  systemStats,
  healthData,
  mobileOpen = false,
  onClose,
  collapsed = false,
  onToggleCollapse,
  breakpoint = 'desktop',
}: SidebarProps) {
  const location = useLocation();
  const [hoverExpanded, setHoverExpanded] = useState(false);
  const [githubVersion, setGithubVersion] = useState<string | null>(null);
  const [navLayout, setNavLayout] = useState<NavCategory[]>([]);
  const [advancedMode, setAdvancedMode] = useState(false);

  const loadNav = async () => {
    // Render the cached layout instantly so nav changes (e.g. deleted tabs)
    // appear immediately without waiting for the network round-trip.
    setNavLayout(getNavLayout());
    try {
      const res = await api.getCustomTabs();
      const synced = syncCustomTabsToLayout(res.tabs);
      setNavLayout(synced);
    } catch {
      /* keep cached layout */
    }
    // Check advanced mode
    try {
      const adv = await api.getAdvancedMode();
      setAdvancedMode(adv.enabled);
    } catch {
      /* advanced mode off */
    }
  };

  useEffect(() => {
    getLatestReleaseCached()
      .then(d => { if (d?.tag_name) setGithubVersion(d.tag_name); })
      .catch(() => {});

    loadNav();

    const handleNavUpdate = () => {
      loadNav();
    };

    window.addEventListener('zfs_nav_updated', handleNavUpdate);
    return () => {
      window.removeEventListener('zfs_nav_updated', handleNavUpdate);
    };
  }, []);

  const isMobile = breakpoint === 'mobile';
  const isTablet = breakpoint === 'tablet';

  const isUpdateAvailable = React.useMemo(() => {
    if (!githubVersion || !healthData?.version) return false;
    const remote = githubVersion.replace(/^v/, '');
    const local = healthData.version.replace(/^v/, '');
    if (remote === local) return false;
    const rParts = remote.split('.').map(Number);
    const lParts = local.split('.').map(Number);
    for (let i = 0; i < Math.max(rParts.length, lParts.length); i++) {
      const r = rParts[i] || 0;
      const l = lParts[i] || 0;
      if (r > l) return true;
      if (r < l) return false;
    }
    return false;
  }, [githubVersion, healthData?.version]);

  const isCollapsed = isMobile
    ? false
    : isTablet
    ? collapsed && !hoverExpanded
    : collapsed;

  const effectiveWidth = isCollapsed ? 56 : 220;

  const handleLogout = () => {
    localStorage.removeItem('zfs_access_token');
    window.location.href = '/login';
  };

  const handleNavClick = () => {
    if (isMobile && onClose) onClose();
    if (isTablet) setHoverExpanded(false);
  };

  const asideStyle: React.CSSProperties = isMobile
    ? {
        position: 'fixed', left: 0, top: 0, bottom: 0, zIndex: 100,
        width: 220,
        transform: 'translateX(' + (mobileOpen ? 0 : -220) + 'px)',
        transition: 'transform 0.25s ease',
        background: 'var(--bg-sidebar)',
        borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: mobileOpen ? '4px 0 32px rgba(0,0,0,0.5)' : 'none',
      }
    : isTablet
    ? {
        position: 'absolute', left: 0, top: 0, bottom: 0,
        zIndex: hoverExpanded ? 50 : 1,
        width: effectiveWidth,
        transition: 'width 0.2s ease, box-shadow 0.2s ease',
        background: 'var(--bg-sidebar)',
        borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: hoverExpanded && !isCollapsed ? '4px 0 24px rgba(0,0,0,0.4)' : 'none',
      }
    : {
        position: 'relative', height: '100%',
        width: effectiveWidth,
        transition: 'width 0.2s ease',
        background: 'var(--bg-sidebar)',
        borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        flexShrink: 0,
      };

  return (
    <aside
      style={asideStyle}
      onMouseEnter={() => isTablet && setHoverExpanded(true)}
      onMouseLeave={() => isTablet && setHoverExpanded(false)}
    >
      <div style={{
        height: 52, display: 'flex', alignItems: 'center',
        gap: 10, padding: isCollapsed ? '0 14px' : '0 16px',
        justifyContent: isCollapsed ? 'center' : 'flex-start',
        borderBottom: '1px solid var(--border)', flexShrink: 0, overflow: 'hidden',
      }}>
        <div style={{
          width: 28, height: 28, background: 'var(--accent-dim)',
          border: '1px solid var(--accent-mid)', borderRadius: 'var(--radius)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <HardDrive size={14} color="var(--accent)" strokeWidth={2} />
        </div>
        {!isCollapsed && (
          <div style={{ overflow: 'hidden' }}>
            <div style={{
              fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600,
              color: 'var(--text-primary)', letterSpacing: '-0.01em', whiteSpace: 'nowrap',
            }}>ZFS Dashboard</div>
            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: 9,
              color: 'var(--text-muted)', letterSpacing: '0.03em',
            }}>Storage Platform</div>
          </div>
        )}
      </div>

      <nav style={{
        flex: 1, overflowY: 'auto', overflowX: 'hidden',
        padding: isCollapsed ? '12px 6px' : '12px 8px',
      }} className="no-scrollbar">
        {(() => {
          // Append Advanced category when advanced mode is enabled
          let layout = navLayout;
          if (advancedMode) {
            layout = [...navLayout, {
              id: 'cat_advanced',
              label: 'Advanced',
              items: [
                { id: 'filesystem', label: 'File System', path: '/filesystem', iconName: 'FolderTree' },
                { id: 'database', label: 'Database', path: '/database', iconName: 'Terminal' },
              ],
            }];
          }
          return layout.map((group, gi) => {
          if (group.items.length === 0) return null;
          return (
            <div key={group.id || gi} style={{ marginBottom: gi < layout.length - 1 ? 24 : 0 }}>
              {!isCollapsed && (
                <div style={{
                  fontFamily: 'var(--font-ui)', fontSize: 10, fontWeight: 600,
                  letterSpacing: '0.12em', textTransform: 'uppercase',
                  color: 'var(--text-muted)', padding: '0 10px 6px',
                }}>{group.label}</div>
              )}
              {group.items.map(item => {
                const IconComponent = ICON_MAP[item.iconName] || Blocks;
                const isActive = location.pathname === item.path || (item.path !== '/dashboard' && location.pathname.startsWith(item.path + '/'));

                return (
                  <NavLink
                    key={item.id}
                    to={item.path}
                    onClick={handleNavClick}
                    title={isCollapsed ? item.label : undefined}
                    style={{
                      display: 'flex', alignItems: 'center',
                      gap: isCollapsed ? 0 : 10, height: 40,
                      padding: isCollapsed ? '0' : '0 10px',
                      justifyContent: isCollapsed ? 'center' : 'flex-start',
                      borderRadius: 'var(--radius)', marginBottom: 2,
                      color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
                      background: isActive ? 'var(--accent-dim)' : 'transparent',
                      borderLeft: isCollapsed ? 'none' : (isActive ? '3px solid var(--accent)' : '3px solid transparent'),
                      outline: isCollapsed && isActive ? '2px solid var(--accent)' : 'none',
                      outlineOffset: 2,
                      fontFamily: 'var(--font-ui)', fontSize: 13,
                      fontWeight: isActive ? 500 : 400,
                      textDecoration: 'none', transition: 'all 0.1s ease', cursor: 'pointer',
                      whiteSpace: 'nowrap', overflow: 'hidden',
                    }}
                    onMouseEnter={e => {
                      if (!isActive) {
                        (e.currentTarget as HTMLElement).style.color = 'var(--text-secondary)';
                        (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)';
                      }
                    }}
                    onMouseLeave={e => {
                      if (!isActive) {
                        (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)';
                        (e.currentTarget as HTMLElement).style.background = 'transparent';
                      }
                    }}
                  >
                    <IconComponent size={18} strokeWidth={isActive ? 2 : 1.75} style={{ flexShrink: 0 }} />
                    {!isCollapsed && item.label}
                  </NavLink>
                );
              })}
            </div>
          );
        });
        })()}
      </nav>

      <div style={{
        padding: isCollapsed ? '12px 6px' : '12px 8px',
        borderTop: '1px solid var(--border)', flexShrink: 0,
      }}>
        {!isCollapsed && (systemStats?.hostname || systemStats?.zfs_version || systemStats?.uptime) && (
          <div style={{
            padding: '8px 10px', marginBottom: 8,
            background: 'rgba(255,255,255,0.02)',
            borderRadius: 'var(--radius)', border: '1px solid var(--border)',
          }}>
            {systemStats?.hostname && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <Server size={10} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                <span style={{
                  fontSize: 11, color: 'var(--text-secondary)',
                  fontFamily: 'var(--font-mono)', fontWeight: 500,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{systemStats.hostname}</span>
              </div>
            )}
            {(githubVersion || healthData?.version) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-ui)', fontWeight: 600 }}>ZFS Dashboard</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                      {healthData?.version || githubVersion}
                    </span>
                  </span>
                </div>
                {isUpdateAvailable && !isCollapsed && (
                  <div style={{
                    background: 'rgba(245, 158, 11, 0.15)', color: 'var(--warning)',
                    fontSize: 10, padding: '4px 6px', borderRadius: 4,
                    textAlign: 'center', fontWeight: 600, fontFamily: 'var(--font-ui)',
                    border: '1px solid rgba(245, 158, 11, 0.3)'
                  }}>
                    Update available ({githubVersion})
                  </div>
                )}
                {isUpdateAvailable && isCollapsed && (
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <span title={`Update available (${githubVersion})`} style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: 'var(--warning)', boxShadow: '0 0 6px var(--warning)',
                    }} />
                  </div>
                )}
              </div>
            )}
            {systemStats?.zfs_version && (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-ui)', fontWeight: 600 }}>ZFS</span>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                  {systemStats.zfs_version.replace('zfs-', '')}
                </span>
              </div>
            )}
            {systemStats?.uptime && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-ui)', fontWeight: 600 }}>Uptime</span>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                  {systemStats.uptime}
                </span>
              </div>
            )}
          </div>
        )}

        <button
          onClick={handleLogout}
          title={isCollapsed ? 'Sign Out' : undefined}
          style={{
            display: 'flex', alignItems: 'center',
            gap: isCollapsed ? 0 : 9, height: 40,
            padding: isCollapsed ? '0' : '0 10px',
            justifyContent: isCollapsed ? 'center' : 'flex-start',
            borderRadius: 'var(--radius)', width: '100%',
            border: 'none', background: 'transparent', cursor: 'pointer',
            color: 'var(--text-muted)', fontFamily: 'var(--font-ui)',
            fontSize: 13, fontWeight: 400, transition: 'all 0.1s',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLElement).style.color = 'var(--danger)';
            (e.currentTarget as HTMLElement).style.background = 'var(--danger-dim)';
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)';
            (e.currentTarget as HTMLElement).style.background = 'transparent';
          }}
        >
          <LogOut size={16} strokeWidth={1.75} style={{ flexShrink: 0 }} />
          {!isCollapsed && 'Sign Out'}
        </button>

        {!isMobile && (
          <button
            onClick={onToggleCollapse}
            title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 6, height: 40, padding: '0', width: '100%',
              border: 'none', background: 'transparent', cursor: 'pointer',
              color: 'var(--text-muted)', fontFamily: 'var(--font-ui)',
              fontSize: 11, fontWeight: 400, transition: 'all 0.1s', marginTop: 4,
              borderRadius: 'var(--radius)',
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.color = 'var(--text-secondary)';
              (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)';
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.color = 'var(--text-muted)';
              (e.currentTarget as HTMLElement).style.background = 'transparent';
            }}
          >
            {isCollapsed
              ? <ChevronRight size={14} />
              : <><ChevronLeft size={14} /><span style={{ whiteSpace: 'nowrap' }}>Collapse</span></>
            }
          </button>
        )}
      </div>
    </aside>
  );
}
