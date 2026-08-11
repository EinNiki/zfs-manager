import React, { useEffect, useId, useState } from 'react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { Activity } from 'lucide-react';
import { api, formatBytes } from '../api';
import { ModuleMetricPoint } from '../types';

interface ModuleWidgetRendererProps {
  moduleId: string;
  widgetKey: string;
  widgetType: 'stat' | 'line' | 'bar' | 'gauge' | 'table';
  metrics: string[];
  title: string;
  unit?: string;
  color?: string;
}

export function formatVal(val: number, unit?: string): string {
  if (val === undefined || val === null || isNaN(val)) return 'N/A';
  if (unit === 'bytes') return formatBytes(val);
  if (unit === 'MB/s' || unit === 'GB/s' || unit === 'MB' || unit === 'KB/s') return `${val.toFixed(1)} ${unit}`;
  if (unit === '%' || unit === 'percent') return `${val.toFixed(1)}%`;
  if (unit === 'ms' || unit === 's') return `${val.toFixed(0)} ${unit}`;
  return val >= 1000 ? val.toLocaleString() : val.toFixed(1);
}

function formatChartTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function ModuleWidgetRenderer({
  moduleId,
  widgetKey,
  widgetType,
  metrics,
  title,
  unit,
  color = 'var(--accent)',
}: ModuleWidgetRendererProps) {
  const [data, setData] = useState<ModuleMetricPoint[]>([]);
  const [timeRange, setTimeRange] = useState('1h');
  const [loading, setLoading] = useState(true);
  const gradId = useId().replace(/:/g, '');

  const primaryMetric = metrics[0] || '';



  useEffect(() => {
    let cancelled = false;
    const loadData = async () => {
      try {
        const res = await api.getModuleMetrics(moduleId, primaryMetric, timeRange);
        if (!cancelled) setData(res.metrics || []);
      } catch (err) {
        console.error(`Failed to load metrics for ${moduleId}/${primaryMetric}:`, err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadData();
    const timer = window.setInterval(loadData, 5000);
    return () => window.clearInterval(timer);
  }, [moduleId, primaryMetric, timeRange]);

  const values = data.map(d => d.value);
  const latestVal = values.length > 0 ? values[values.length - 1] : 0;
  const minVal = values.length > 0 ? Math.min(...values) : 0;
  const maxVal = values.length > 0 ? Math.max(...values) : 0;
  const avgVal = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;

  // Grafana-style Technical Container Box using System Color Palette
  const panelFrameStyle: React.CSSProperties = {
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
    boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    height: widgetType === 'stat' ? 140 : 280,
    width: '100%',
    boxSizing: 'border-box',
    position: 'relative',
    overflow: 'hidden',
  };

  // Render Stat Card
  if (widgetType === 'stat') {
    return (
      <div style={panelFrameStyle}>
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: color }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {title}
            </span>
          </div>
          <Activity size={14} color={color} />
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 30, fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
            {formatVal(latestVal, unit)}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
            MIN: <strong style={{ color: 'var(--text-secondary)' }}>{formatVal(minVal, unit)}</strong>
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
            AVG: <strong style={{ color: 'var(--text-secondary)' }}>{formatVal(avgVal, unit)}</strong>
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
            MAX: <strong style={{ color: 'var(--text-secondary)' }}>{formatVal(maxVal, unit)}</strong>
          </span>
        </div>
      </div>
    );
  }

  // Render Gauge Card
  if (widgetType === 'gauge') {
    const pct = Math.min(100, Math.max(0, latestVal));
    const circumference = 2 * Math.PI * 38;
    const strokeDashoffset = circumference * (1 - pct / 100);

    return (
      <div style={{ ...panelFrameStyle, height: 200, alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: color }} />
        <div style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
            <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)' }}>
              {title}
            </span>
          </div>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>{moduleId}</span>
        </div>

        <div style={{ position: 'relative', width: 110, height: 110, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="110" height="110" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="38" stroke="var(--border)" strokeWidth="7" fill="none" />
            <circle
              cx="50" cy="50" r="38" stroke={color} strokeWidth="7" fill="none"
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
              strokeLinecap="round"
              transform="rotate(-90 50 50)"
              style={{ transition: 'stroke-dashoffset 0.4s cubic-bezier(0.4, 0, 0.2, 1)' }}
            />
          </svg>
          <div style={{ position: 'absolute', textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 800, color: 'var(--text-primary)' }}>
              {formatVal(latestVal, unit)}
            </div>
            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              {primaryMetric}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Render Line / Bar Chart
  const chartData = data.map(d => ({
    time: formatChartTime(d.collected_at),
    val: d.value,
  }));

  return (
    <div style={panelFrameStyle}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: color }} />
      {/* Header + Summaries */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
            <h4 style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
              {title}
            </h4>
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
            {moduleId} · {primaryMetric}
          </div>
        </div>

        {/* Header Metric Summaries Bar (Grafana-style layout using system colors) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 10px' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 9, fontFamily: 'var(--font-ui)', fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.05em' }}>LAST</span>
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 700, color: color }}>{formatVal(latestVal, unit)}</span>
          </div>
          <div style={{ width: 1, height: 16, background: 'var(--border)' }} />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 9, fontFamily: 'var(--font-ui)', fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.05em' }}>MIN</span>
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-secondary)' }}>{formatVal(minVal, unit)}</span>
          </div>
          <div style={{ width: 1, height: 16, background: 'var(--border)' }} />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 9, fontFamily: 'var(--font-ui)', fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.05em' }}>AVG</span>
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-secondary)' }}>{formatVal(avgVal, unit)}</span>
          </div>
          <div style={{ width: 1, height: 16, background: 'var(--border)' }} />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 9, fontFamily: 'var(--font-ui)', fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.05em' }}>MAX</span>
            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 700, color: color }}>{formatVal(maxVal, unit)}</span>
          </div>

          <select
            value={timeRange}
            onChange={e => setTimeRange(e.target.value)}
            style={{
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)',
              fontSize: 10, fontFamily: 'var(--font-mono)', fontWeight: 700, padding: '2px 6px',
              cursor: 'pointer', marginLeft: 4,
            }}
          >
            <option value="15m">15m</option>
            <option value="1h">1h</option>
            <option value="6h">6h</option>
            <option value="1d">24h</option>
            <option value="1w">7d</option>
          </select>
        </div>
      </div>

      {/* Chart Canvas */}
      <div style={{ flex: 1, width: '100%', minHeight: 0, marginTop: 4 }}>
        {loading && chartData.length === 0 ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12, fontFamily: 'var(--font-ui)' }}>
            Loading data…
          </div>
        ) : chartData.length === 0 ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12, fontFamily: 'var(--font-ui)' }}>
            No metric data available for the selected time range
          </div>
        ) : widgetType === 'bar' ? (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 12, left: -20, bottom: 0 }}>
              <CartesianGrid stroke="var(--border-subtle)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="time" stroke="var(--text-muted)" fontSize={10} tickLine={false} axisLine={{ stroke: 'var(--border)' }} />
              <YAxis stroke="var(--text-muted)" fontSize={10} tickLine={false} axisLine={false} tickFormatter={v => formatVal(v, unit)} />
              <Tooltip
                contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, color: 'var(--text-primary)' }}
                formatter={(val: any) => [formatVal(Number(val), unit), primaryMetric]}
              />
              <Bar dataKey="val" fill={color} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 8, right: 12, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id={`grad-${gradId}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={color} stopOpacity={0.35} />
                  <stop offset="95%" stopColor={color} stopOpacity={0.01} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--border-subtle)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="time" stroke="var(--text-muted)" fontSize={10} tickLine={false} axisLine={{ stroke: 'var(--border)' }} />
              <YAxis stroke="var(--text-muted)" fontSize={10} tickLine={false} axisLine={false} tickFormatter={v => formatVal(v, unit)} />
              <Tooltip
                contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, color: 'var(--text-primary)' }}
                formatter={(val: any) => [formatVal(Number(val), unit), primaryMetric]}
              />
              <Area
                type="monotone"
                dataKey="val"
                stroke={color}
                strokeWidth={2}
                fillOpacity={1}
                fill={`url(#grad-${gradId})`}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
