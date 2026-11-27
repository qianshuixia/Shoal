// Small pure formatters shared by the StreamView modules.

export function fmtSec(sec: number): string {
  const s = Math.max(1, Math.floor(sec));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r > 0 ? `${m} 分 ${r} 秒` : `${m} 分`;
}

export function fmtCompactSec(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r > 0 ? `${m}m${String(r).padStart(2, '0')}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

export function clipPreview(raw: string, max = 46): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  const cps = [...oneLine];
  return cps.length > max ? cps.slice(0, max).join('') + '…' : oneLine;
}

export function fileBase(p: string): string {
  const clean = p.replaceAll('\\', '/').replace(/\/+$/, '');
  return clean.split('/').pop() || clean;
}

// Replaces local absolute paths (including spaced directory/file names and file:// URIs) for privacy mode errors.
export function redactLocalPaths(text: string): string {
  let out = text.replace(/file:\/\/\/?[^\s"'<>|*?\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]+/gi, '已隐藏路径');
  out = out.replace(/(?<=：)(?:[A-Za-z]:[\\/]|\\\\|\/)[^\r\n]+/g, (m) => {
    const trailing = /^(.*[\\/])([^\s"'<>|*?]+)(\s+[\s\S]*)$/.exec(m);
    if (trailing && !/[\\/]/.test(trailing[3]) && !/\.[A-Za-z0-9]{1,8}$/.test(trailing[3].trim())) {
      return `…/${trailing[2]}${trailing[3]}`;
    }
    return '已隐藏路径';
  });
  out = out.replace(
    /(?:[A-Za-z]:[\\/]|\\\\)(?:[^\r\n"'<>|*?\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]*[\\/])?[^\s"'<>|*?]+|\/(?:[^\r\n"'<>|/*?\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]*\/)+[^\s"'<>|/*?]+/g,
    (m) => {
      const base = fileBase(m);
      return base && base !== m ? `…/${base}` : '…';
    },
  );
  return out;
}

// "12:41" for today, "11-26 12:41" for older timestamps.
export function fmtBlockTime(at: number | undefined, nowMs: number = Date.now()): string {
  if (!at || !Number.isFinite(at)) return '';
  const d = new Date(at);
  const n = new Date(nowMs);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === n.toDateString()) return hm;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}
