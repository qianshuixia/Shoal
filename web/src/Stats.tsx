import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePrivacy } from './privacy.ts';
import type { AgentKind, UsageCounts, UsageReport, UsageRow } from '../../shared/protocol.ts';
import { AGENT_LABEL, usageTotal } from '../../shared/protocol.ts';
import { AgentIcon } from './agentIcons.tsx';
import { fmtPct, fmtTokens, hitRate } from './util.ts';

type Preset = 'today' | '7d' | '30d' | 'all' | 'custom';
type Group = 'byTask' | 'byModel' | 'byVendor' | 'byAgent' | 'byProject';

const PRESETS: [Preset, string][] = [['today', '今天'], ['7d', '近 7 天'], ['30d', '近 30 天'], ['all', '全部'], ['custom', '自定义']];
const GROUPS: [Group, string][] = [['byTask', '任务'], ['byModel', '模型'], ['byVendor', '厂商'], ['byAgent', 'CLI'], ['byProject', '项目']];
const REFRESH_MS = 10_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Stack order bottom -> top; colors are the dataviz dark categorical slots 1-4, validated on --surface.
const SERIES: { key: keyof UsageCounts; label: string; color: string }[] = [
  { key: 'cacheRead', label: '缓存读取', color: '#3987e5' },
  { key: 'cacheWrite', label: '缓存写入', color: '#d95926' },
  { key: 'input', label: '输入', color: '#199e70' },
  { key: 'output', label: '输出', color: '#c98500' },
];

const midnight = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (t: number, n: number) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };
const dateInput = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const parseDate = (s: string) => { const [y, m, d] = s.split('-').map(Number); return y ? new Date(y, m - 1, d).getTime() : NaN; };

function rangeOf(p: Preset, start: string, end: string, now: number): { from: number | null; to: number | null } {
  const today = midnight(now);
  if (p === 'today') return { from: today, to: null };
  if (p === '7d') return { from: addDays(today, -6), to: null };
  if (p === '30d') return { from: addDays(today, -29), to: null };
  if (p === 'custom') {
    const a = parseDate(start);
    const b = parseDate(end);
    return { from: Number.isFinite(a) ? a : null, to: Number.isFinite(b) ? addDays(b, 1) : null };
  }
  return { from: null, to: null };
}

export const fmt = fmtTokens;
const full = (n: number) => n.toLocaleString('en-US');
const pct = fmtPct;
const clock = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
const day = (t: number) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };

export function StatsView({ visible }: { visible: boolean }) {
  const [preset, setPreset] = useState<Preset>('7d');
  const [start, setStart] = useState(() => dateInput(addDays(Date.now(), -6)));
  const [end, setEnd] = useState(() => dateInput(Date.now()));
  const [group, setGroup] = useState<Group>('byTask');
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!visible) return;
    const t = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => clearInterval(t);
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const { from, to } = rangeOf(preset, start, end, Date.now());
    const q = new URLSearchParams();
    if (from !== null) q.set('from', String(from));
    if (to !== null) q.set('to', String(to));
    let stale = false;
    setLoading(true);
    fetch(`/api/usage?${q}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        return body as UsageReport;
      })
      .then((r) => { if (!stale) { setReport(r); setError(''); } })
      .catch((e: Error) => { if (!stale) setError(`读取统计失败：${e.message}`); })
      .finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; };
  }, [visible, preset, start, end, tick]);

  const total = report?.total;
  const rows = report?.[group] ?? [];
  const sum = total ? usageTotal(total) : 0;

  return (
    <section className="stats" data-testid="stats-view" hidden={!visible}>
      <div className="stats-inner">
        <div className="stats-filters" role="group" aria-label="时间范围">
          {PRESETS.map(([p, label]) => (
            <button key={p} className={`seg ${preset === p ? 'on' : ''}`} aria-pressed={preset === p} data-testid={`range-${p}`} onClick={() => setPreset(p)}>
              {label}
            </button>
          ))}
          {preset === 'custom' && (
            <span className="stats-custom">
              <input type="date" aria-label="开始日期" data-testid="range-start" value={start} max={end} onChange={(e) => setStart(e.target.value)} />
              <span className="muted">至</span>
              <input type="date" aria-label="结束日期" data-testid="range-end" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
            </span>
          )}
          <span className="stats-meta">
            {error ? <span className="form-error">{error}</span>
              : report ? <>更新于 {clock(report.scannedAt)}{report.since !== null && <>，记录从 {new Date(report.since).toLocaleDateString('zh-CN')} 开始</>}</> : '读取中…'}
          </span>
        </div>

        <div className={`stats-body ${loading && report ? 'refreshing' : ''}`}>
          {total && (
            <div className="tiles" data-testid="usage-tiles">
              <Tile hero label="总 token" value={sum} testId="usage-total" />
              <Tile label="输入" value={total.input} />
              <Tile label="输出" value={total.output} note={total.reasoning ? `含推理 ${fmt(total.reasoning)}` : undefined} />
              <Tile label="缓存读取" value={total.cacheRead} />
              <Tile label="缓存写入" value={total.cacheWrite} />
              <div className="tile">
                <span className="tile-label">缓存命中率</span>
                <span className="tile-value" data-testid="usage-hit-rate">{pct(hitRate(total))}</span>
                <span className="tile-note">缓存读取占全部输入</span>
              </div>
              <div className="tile">
                <span className="tile-label">请求</span>
                <span className="tile-value" data-testid="usage-requests">{full(total.requests)}</span>
              </div>
            </div>
          )}

          {report && (
            <div className="card">
              <div className="card-head">
                <span className="card-title">用量趋势</span>
                <Legend />
              </div>
              <Trend report={report} />
            </div>
          )}

          {report && (
            <div className="card">
              <div className="card-head">
                <span className="card-title">分组明细</span>
                <span className="segs" role="tablist" aria-label="分组方式">
                  {GROUPS.map(([g, label]) => (
                    <button key={g} role="tab" aria-selected={group === g} className={`seg ${group === g ? 'on' : ''}`} data-testid={`group-${g}`} onClick={() => setGroup(g)}>
                      按{label}
                    </button>
                  ))}
                </span>
              </div>
              {rows.length ? <UsageTable rows={rows} group={group} sum={sum} /> : <div className="stats-empty">这个时间段没有 token 记录。</div>}
            </div>
          )}

          <p className="stats-foot">
            统计工作台启动的会话，从各 CLI 自己的对话记录读取（Claude Code、Codex、Antigravity），每分钟和打开本页时更新。
            输入不含缓存；输出含推理。换 agent 时生成交接卡片的短调用不计入。
          </p>
        </div>
      </div>
    </section>
  );
}

function Tile({ label, value, note, hero, testId }: { label: string; value: number; note?: string; hero?: boolean; testId?: string }) {
  return (
    <div className={`tile ${hero ? 'hero' : ''}`} title={full(value)}>
      <span className="tile-label">{label}</span>
      <span className="tile-value" data-testid={testId}>{fmt(value)}</span>
      {note && <span className="tile-note">{note}</span>}
    </div>
  );
}

function Legend() {
  return (
    <span className="legend">
      {SERIES.map((s) => (
        <span key={s.key} className="legend-item"><span className="swatch" style={{ background: s.color }} />{s.label}</span>
      ))}
    </span>
  );
}

interface Column { t: number; c: UsageCounts }

// Hour columns for ranges up to two days, day columns otherwise; empty slots are kept so gaps show.
function columns(r: UsageReport): { cols: Column[]; hourly: boolean } {
  const now = Date.now();
  const from = r.from ?? (r.since !== null ? midnight(r.since) : midnight(now));
  const to = Math.min(r.to ?? Infinity, now);
  const hourly = (r.to ?? addDays(midnight(now), 1)) - from <= 2 * DAY;
  const zero = (): UsageCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, requests: 0 });
  const slots = new Map<number, Column>();
  if (hourly) {
    const endHour = r.to ?? addDays(midnight(now), 1);
    for (let t = from; t < endHour; t += HOUR) slots.set(t, { t, c: zero() });
  } else {
    for (let t = midnight(from); t < to; t = addDays(t, 1)) slots.set(t, { t, c: zero() });
  }
  for (const h of r.hours) {
    const col = slots.get(hourly ? h.t : midnight(h.t));
    if (!col) continue;
    for (const k of Object.keys(col.c) as (keyof UsageCounts)[]) col.c[k] += h[k];
  }
  return { cols: [...slots.values()], hourly };
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// Path of a column segment, rounded only at its data end.
const segPath = (x: number, y: number, w: number, h: number, r: number) => {
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
};

function Trend({ report }: { report: UsageReport }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 800));
    ro.observe(el);
    setWidth(el.clientWidth || 800);
    return () => ro.disconnect();
  }, []);

  const { cols, hourly } = columns(report);
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const H = Math.round(13 * rem);
  const m = { l: Math.round(3 * rem), r: 8, t: 8, b: Math.round(1.5 * rem) };
  const pw = Math.max(1, width - m.l - m.r);
  const ph = H - m.t - m.b;
  const max = niceMax(Math.max(0, ...cols.map((c) => usageTotal(c.c))));
  const band = pw / Math.max(1, cols.length);
  const bw = Math.max(2, Math.min(24, band * 0.68));
  const y = (v: number) => m.t + ph - (v / max) * ph;
  const every = Math.max(1, Math.ceil(cols.length / Math.max(2, Math.floor(pw / (4 * rem)))));
  const label = (t: number) => (hourly ? `${new Date(t).getHours()}时` : day(t));
  const hc = hover !== null ? cols[hover] : undefined;

  return (
    <div className="trend" ref={box} data-testid="usage-trend" onPointerLeave={() => setHover(null)}>
      <svg width={width} height={H} role="img" aria-label={`按${hourly ? '小时' : '天'}的 token 用量，最高 ${fmt(Math.max(0, ...cols.map((c) => usageTotal(c.c))))}`}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={m.l} x2={width - m.r} y1={y(max * f)} y2={y(max * f)} className={f === 0 ? 'axis' : 'grid'} />
            <text x={m.l - 6} y={y(max * f)} dy="0.32em" textAnchor="end" className="tick">{fmt(max * f)}</text>
          </g>
        ))}
        {cols.map((col, i) => {
          const cx = m.l + band * i + band / 2;
          let acc = 0;
          const segs = SERIES.map((s) => ({ s, v: col.c[s.key] })).filter((x) => x.v > 0);
          return (
            <g key={col.t}>
              {hover === i && <rect x={m.l + band * i} y={m.t} width={band} height={ph} className="hover-band" />}
              {segs.map(({ s, v }, j) => {
                const y0 = y(acc);
                acc += v;
                const y1 = y(acc);
                const gap = j > 0 ? 2 : 0; // surface gap between stacked segments
                const h = Math.max(0, y0 - y1 - gap);
                if (h <= 0) return null;
                const x = cx - bw / 2;
                return j === segs.length - 1
                  ? <path key={s.key} d={segPath(x, y1, bw, h, 4)} fill={s.color} />
                  : <rect key={s.key} x={x} y={y1} width={bw} height={h} fill={s.color} />;
              })}
              {i % every === 0 && <text x={cx} y={H - 6} textAnchor="middle" className="tick">{label(col.t)}</text>}
              <rect x={m.l + band * i} y={m.t} width={band} height={ph} fill="transparent" onPointerEnter={() => setHover(i)} />
            </g>
          );
        })}
      </svg>
      {hc && (
        <div
          className="tooltip"
          data-testid="trend-tooltip"
          // Beside the hovered column, on whichever side has room, so the column stays visible.
          style={m.l + band * (hover! + 1) + 13 * rem <= width ? { left: m.l + band * (hover! + 1) + 8, top: 0 } : { right: width - (m.l + band * hover!) + 8, top: 0 }}
        >
          <div className="tt-head">
            {hourly ? `${day(hc.t)} ${new Date(hc.t).getHours()}:00–${new Date(hc.t).getHours() + 1}:00` : new Date(hc.t).toLocaleDateString('zh-CN')}
          </div>
          <div className="tt-row tt-total"><strong>{full(usageTotal(hc.c))}</strong><span>合计</span></div>
          {[...SERIES].reverse().map((s) => (
            <div key={s.key} className="tt-row">
              <span className="tt-key" style={{ background: s.color }} /><strong>{full(hc.c[s.key])}</strong><span>{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function UsageTable({ rows, group, sum }: { rows: UsageRow[]; group: Group; sum: number }) {
  const privacy = usePrivacy();
  const secret = group === 'byTask' || group === 'byProject'; // names of tasks / projects; models, vendors and CLIs stay readable
  return (
    <div className="table-wrap">
      <table className="usage-table" data-testid="usage-table">
        <thead>
          <tr>
            <th className="name">{GROUPS.find(([g]) => g === group)![1]}</th>
            <th>总量</th><th className="share">占比</th><th>输入</th><th>输出</th><th>缓存读取</th><th>缓存写入</th><th>命中率</th><th>请求</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const t = usageTotal(r);
            const share = sum ? t / sum : 0;
            return (
              <tr key={r.key || '(none)'} data-testid="usage-row" data-key={r.key}>
                <td className="name">
                  <span className="row-name">
                    {r.agents?.map((a) => <AgentIcon key={a} agent={a as AgentKind} />)}
                    {group === 'byAgent' && <AgentIcon agent={r.key as AgentKind} />}
                    <span className="row-label" data-private={secret ? '' : undefined} title={secret && privacy ? undefined : r.label}>{group === 'byAgent' ? AGENT_LABEL[r.key as AgentKind] ?? r.label : r.label}</span>
                    {r.deleted && r.key && <span className="row-tag">已删除</span>}
                  </span>
                  {(r.project || r.vendor) && <span className="row-sub" data-private={secret ? '' : undefined}>{r.project || r.vendor}</span>}
                </td>
                <td title={full(t)}><strong>{fmt(t)}</strong></td>
                <td className="share">
                  <span className="share-cell">
                    <span className="share-bar"><span style={{ width: `${Math.max(share * 100, 0.5)}%` }} /></span>
                    <span className="share-num">{pct(share)}</span>
                  </span>
                </td>
                <td title={full(r.input)}>{fmt(r.input)}</td>
                <td title={full(r.output)}>{fmt(r.output)}</td>
                <td title={full(r.cacheRead)}>{fmt(r.cacheRead)}</td>
                <td title={full(r.cacheWrite)}>{fmt(r.cacheWrite)}</td>
                <td>{pct(hitRate(r))}</td>
                <td>{full(r.requests)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
