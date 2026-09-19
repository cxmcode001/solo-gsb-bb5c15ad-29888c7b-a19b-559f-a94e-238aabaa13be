import { useMemo, useState } from 'react';
import type { ClusterAudit, ParsedFont } from '../types';
import type { ChainEntry } from '../lib/audit';
import {
  buildAuditReport,
  buildCssExport,
  copyToClipboard,
  downloadText,
  type AuditInput,
  type AuditResultData,
} from '../lib/audit';
import { displayCluster, formatCodepoint } from '../lib/grapheme';
import type { FailureScenario } from '../lib/resilience';
import ClusterTable, { type ClusterFilter } from './ClusterTable';
import ResiliencePanel from './ResiliencePanel';
import BaselineCompare from './BaselineCompare';
import type { ParsedBaseline } from '../lib/baseline';

interface ResultsPanelProps {
  clusters: ClusterAudit[];
  validFonts: ParsedFont[];
  chain: ChainEntry[];
  unselected: { name: string; preference: number }[];
  feasible: boolean;
  exact: boolean;
  objective: number;
  nodesExplored: number;
  auditInput: AuditInput;
  hasText: boolean;
  useMeasured: boolean;
  resilience: FailureScenario[];
}

/** 结果区：概览、回退链、缺失告警、字素簇明细、导出 */
export default function ResultsPanel(props: ResultsPanelProps) {
  const {
    clusters,
    validFonts,
    chain,
    unselected,
    feasible,
    exact,
    objective,
    nodesExplored,
    auditInput,
    hasText,
    useMeasured,
    resilience,
  } = props;

  const [filter, setFilter] = useState<ClusterFilter>('all');
  const [copied, setCopied] = useState<'css' | 'json' | null>(null);
  /** 已导入并校验通过的基线（非法导入不覆盖它）；状态提升到面板顶层，清空文本时也保留 */
  const [baseline, setBaseline] = useState<ParsedBaseline | null>(null);
  const [baselineFileName, setBaselineFileName] = useState<string | null>(null);

  const missing = clusters.filter((c) => c.status === 'missing');
  const coveredCount = clusters.length - missing.length;
  const generatedAt = useMemo(() => new Date().toISOString(), [clusters, chain]);

  const resolveFontName = (i: number | null): string | null =>
    i === null || i >= validFonts.length ? null : validFonts[i].name;

  const cssText = useMemo(() => buildCssExport(chain, generatedAt), [chain, generatedAt]);
  const jsonText = useMemo(() => {
    const result: AuditResultData = {
      feasible,
      exact,
      objective,
      nodesExplored,
      chain,
      unselected,
      clusters,
      validFonts,
    };
    return JSON.stringify(buildAuditReport(auditInput, result, generatedAt), null, 2);
  }, [auditInput, feasible, exact, objective, nodesExplored, chain, unselected, clusters, validFonts, generatedAt]);

  const flashCopied = async (kind: 'css' | 'json', text: string) => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(kind);
      window.setTimeout(() => setCopied((cur) => (cur === kind ? null : cur)), 1500);
    }
  };

  if (!hasText) {
    return (
      <div className="results">
        <div className="empty-state">
          <div className="empty-icon">⌨️</div>
          <p>在左侧粘贴待渲染文本，审计结果将实时显示在这里。</p>
        </div>
        <section className="block">
          <BaselineCompare
            clusters={clusters}
            fontName={resolveFontName}
            hasText={hasText}
            baseline={baseline}
            baselineFileName={baselineFileName}
            onBaseline={(b, name) => {
              setBaseline(b);
              setBaselineFileName(name);
            }}
            onClearBaseline={() => {
              setBaseline(null);
              setBaselineFileName(null);
            }}
          />
        </section>
      </div>
    );
  }

  return (
    <div className="results">
      <div className="stat-grid">
        <div className="stat">
          <div className="stat-value">{clusters.length}</div>
          <div className="stat-label">字素簇</div>
        </div>
        <div className="stat ok">
          <div className="stat-value">{coveredCount}</div>
          <div className="stat-label">已覆盖</div>
        </div>
        <div className={`stat${missing.length ? ' bad' : ''}`}>
          <div className="stat-value">{missing.length}</div>
          <div className="stat-label">缺失</div>
        </div>
        <div className="stat">
          <div className="stat-value">{chain.length}</div>
          <div className="stat-label">回退链长度</div>
        </div>
        <div className="stat">
          <div className="stat-value">{exact ? '精确' : '启发式'}</div>
          <div className="stat-label">求解质量</div>
        </div>
      </div>

      {!feasible && (
        <div className="alert bad">
          <strong>⚠ 存在 {missing.length} 个无法覆盖的字素簇</strong>
          <span className="alert-detail">
            {missing.slice(0, 8).map((c) => (
              <span key={c.index} className="missing-chip" title={c.missingCodepoints.map(formatCodepoint).join(' ')}>
                {displayCluster(c.text)}
              </span>
            ))}
            {missing.length > 8 && ` 等 ${missing.length} 个`}
            —— 请为缺失码位补充字体范围，或从文本中移除这些字符。
          </span>
        </div>
      )}
      {feasible && validFonts.length > 0 && (
        <div className="alert ok">✓ 可行：当前回退链可覆盖全部 {clusters.length} 个字素簇。</div>
      )}

      {useMeasured && (
        <div className="alert mode">
          <strong>🧪 按实测覆盖求解已开启</strong>
          <span className="alert-detail">
            已上传字体使用其 cmap（format 4/12）实测码位参与分析与求解；未上传字体仍用声明范围；
            清除文件后立即恢复声明范围。
          </span>
        </div>
      )}

      <section className="block">
        <h3>最优回退链</h3>
        {chain.length === 0 ? (
          <p className="muted">暂无可选字体 —— 请先添加至少一种范围有效的字体。</p>
        ) : (
          <>
            <ol className="chain-list">
              {chain.map((e, i) => (
                <li key={e.fontIndex} className="chain-item">
                  <span className="chain-order">{i + 1}</span>
                  <span className="chain-name">{e.name || '(未命名)'}</span>
                  <span className="chain-meta">
                    承接 {e.assignedClusters} 簇 · 偏好 #{e.preference + 1}
                  </span>
                </li>
              ))}
            </ol>
            {unselected.length > 0 && (
              <p className="muted small">
                未入选（冗余）：{unselected.map((u) => u.name || '(未命名)').join('、')}
                —— 其覆盖范围已被链中更优先的字体包含。
              </p>
            )}
            <p className="muted small">
              浏览器按 font-family 顺序回退：每个字素簇由链中第一种覆盖它的字体承接。
            </p>
          </>
        )}
      </section>

      {resilience.length > 0 && (
        <section className="block">
          <ResiliencePanel
            scenarios={resilience}
            validFonts={validFonts}
            chain={chain}
            graphemeCount={clusters.length}
            coveredCount={coveredCount}
            missingCount={missing.length}
            auditInput={auditInput}
            generatedAt={generatedAt}
          />
        </section>
      )}

      <section className="block">
        <BaselineCompare
          clusters={clusters}
          fontName={resolveFontName}
          hasText={hasText}
          baseline={baseline}
          baselineFileName={baselineFileName}
          onBaseline={(b, name) => {
            setBaseline(b);
            setBaselineFileName(name);
          }}
          onClearBaseline={() => {
            setBaseline(null);
            setBaselineFileName(null);
          }}
        />
      </section>

      <section className="block">
        <ClusterTable clusters={clusters} validFonts={validFonts} filter={filter} onFilterChange={setFilter} />
      </section>

      <section className="block">
        <h3>导出</h3>
        <div className="export-grid">
          <div className="export-card">
            <div className="export-head">
              <span>CSS font-family</span>
              <button className="btn small" onClick={() => flashCopied('css', cssText)}>
                {copied === 'css' ? '✓ 已复制' : '复制'}
              </button>
            </div>
            <pre className="code-block mono">{cssText}</pre>
          </div>
          <div className="export-card">
            <div className="export-head">
              <span>审计 JSON</span>
              <span className="export-actions">
                <button className="btn small" onClick={() => flashCopied('json', jsonText)}>
                  {copied === 'json' ? '✓ 已复制' : '复制'}
                </button>
                <button
                  className="btn small primary"
                  onClick={() => downloadText('font-fallback-audit.json', jsonText)}
                >
                  下载 .json
                </button>
              </span>
            </div>
            <pre className="code-block mono json-preview">{jsonText.slice(0, 1200)}{jsonText.length > 1200 ? '\n…（完整内容请复制或下载）' : ''}</pre>
          </div>
        </div>
      </section>
    </div>
  );
}
