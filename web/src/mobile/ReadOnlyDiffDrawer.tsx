import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DiffPayload, ProjectChanges } from '../../../shared/protocol.ts';
import { mobileGet } from './api.ts';
import { buildUnifiedDiffHunks } from './diffHunks.ts';

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;

export function ReadOnlyDiffDrawer({
  projectId,
  projectName,
  gitKey,
  onClose,
}: {
  projectId: string;
  projectName: string;
  gitKey?: string;
  onClose(): void;
}) {
  const [changes, setChanges] = useState<ProjectChanges | null>(null);
  const [selectedPath, setSelectedPath] = useState('');
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState('');
  const [refreshTick, setRefreshTick] = useState(0);

  const loadChanges = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await mobileGet<ProjectChanges>(`/api/projects/${encodeURIComponent(projectId)}/changes`);
      setChanges(res);
      setSelectedPath((prev) => (prev && res.files.some((f) => f.path === prev) ? prev : (res.files[0]?.path ?? '')));
      setRefreshTick((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadChanges();
  }, [loadChanges, gitKey]);

  useEffect(() => {
    if (!selectedPath) {
      setDiff(null);
      return;
    }
    let alive = true;
    setDiffLoading(true);
    setError('');
    mobileGet<DiffPayload>(`/api/projects/${encodeURIComponent(projectId)}/diff?path=${encodeURIComponent(selectedPath)}`).then(
      (d) => {
        if (!alive) return;
        setDiff(d);
        setDiffLoading(false);
      },
      (e) => {
        if (!alive) return;
        setError((e as Error).message);
        setDiffLoading(false);
      },
    );
    return () => { alive = false; };
  }, [projectId, selectedPath, refreshTick]);

  const hunks = useMemo(() => {
    if (!diff || diff.binary || diff.tooLarge || diff.isDirectory) return [];
    return buildUnifiedDiffHunks(diff.base, diff.head);
  }, [diff]);

  return (
    <div className="mob-drawer" data-testid="mobile-diff-drawer">
      <header className="mob-header">
        <div className="mob-title-wrap">
          <span className="mob-title">只读代码变更 · {projectName}</span>
          <span className="mob-sub">
            {changes?.git ? `分支 ${changes.git.branch} · ${changes.files.length} 个变更文件` : '工作区变更'}
          </span>
        </div>
        <button type="button" className="mob-btn compact ghost" data-testid="mobile-diff-refresh" disabled={loading} onClick={() => void loadChanges()}>
          刷新
        </button>
        <button type="button" className="mob-btn compact" data-testid="mobile-diff-close" onClick={onClose}>
          关闭
        </button>
      </header>

      <div className="mob-scroll">
        {loading && <div className="mob-sub">正在读取变更列表…</div>}
        {error && <div className="form-error">{error}</div>}
        {!loading && changes && changes.files.length === 0 && (
          <div className="mob-sub">工作区干净，暂无未提交改动。</div>
        )}

        {changes && changes.files.length > 0 && (
          <>
            <div style={{ display: 'flex', gap: '0.375rem', overflowX: 'auto', flex: 'none', paddingBottom: '0.25rem' }}>
              {changes.files.map((f) => (
                <button
                  key={f.path}
                  type="button"
                  className={`mob-btn compact ${f.path === selectedPath ? 'primary' : ''}`}
                  data-testid={`mobile-diff-file-${f.path}`}
                  onClick={() => setSelectedPath(f.path)}
                  style={{ flex: 'none', fontFamily: 'Consolas, monospace', fontSize: '0.75rem' }}
                >
                  <span>[{f.status}]</span>
                  <span data-private="">{f.path}</span>
                  {f.added !== null && f.deleted !== null && (
                    <span style={{ opacity: 0.75 }}>+{f.added}/-{f.deleted}</span>
                  )}
                </button>
              ))}
            </div>

            <div data-testid="mobile-diff-content" style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
              {diffLoading && <div className="mob-sub">正在加载差异…</div>}
              {!diffLoading && diff && diff.isDirectory && (
                <div className="mob-sub">此条目为嵌套目录 / Git 子模块，手机端不支持展开目录差异。</div>
              )}
              {!diffLoading && diff && diff.tooLarge && (
                <div className="mob-sub">文件超过对比体积上限，请在电脑端桌面版查看。</div>
              )}
              {!diffLoading && diff && !diff.isDirectory && !diff.tooLarge && diff.binary && (
                IMAGE_EXT_RE.test(diff.path) ? (
                  <div className="mob-pair-card">
                    <div className="mob-sub">图片变更预览（只读）：</div>
                    <img
                      src={`/api/projects/${encodeURIComponent(projectId)}/raw?path=${encodeURIComponent(diff.path)}`}
                      alt={diff.path}
                      style={{ maxWidth: '100%', borderRadius: '0.5rem', background: '#0f1012' }}
                    />
                  </div>
                ) : (
                  <div className="mob-sub">二进制文件不支持文本差异预览。</div>
                )
              )}
              {!diffLoading && diff && !diff.binary && !diff.tooLarge && !diff.isDirectory && hunks.length === 0 && (
                <div className="mob-sub">文件内容无行级文本差异（例如仅文件权限变化或空文件）。</div>
              )}
              {!diffLoading && hunks.map((hunk, i) => (
                <div key={i} className="mob-diff-hunk">
                  <div className="mob-diff-hunk-head">{hunk.header}</div>
                  <div className="mob-diff-lines">
                    {hunk.lines.map((line, j) => (
                      <div key={j} className={`mob-diff-line ${line.kind}`}>
                        <span className="mob-diff-ln">{line.oldLine ?? ''}</span>
                        <span className="mob-diff-ln">{line.newLine ?? ''}</span>
                        <span className="mob-diff-sigil">
                          {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                        </span>
                        <span>{line.text}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
