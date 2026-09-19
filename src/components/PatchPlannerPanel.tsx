import { useMemo, useState } from 'react';
import type { ParsedFont, ScenarioClusterAudit } from '../types';
import {
  buildPatchPlanReport,
  downloadText,
  type AuditInput,
} from '../lib/audit';
import { planPatchBudget } from '../lib/patchPlanner';
import { displayCluster, formatCodepoint } from '../lib/grapheme';
import { formatRangesCompact, normalizeRanges } from '../lib/ranges';

interface PatchPlannerPanelProps {
  /** 当前参与求解的簇（单场景：活动场景；场景集：全部场景展平） */
  clusters: ScenarioClusterAudit[];
  validFonts: ParsedFont[];
  auditInput: AuditInput;
  generatedAt: string;
  /** 场景 id -> 显示名（逐场景统计与逐轮明细用） */
  scenarioNames?: Map<string, string>;
}

const ROUND_LIMIT = 20;
const CHIP_LIMIT = 16;

/** 码位列表 → 紧凑区间文本（连续码位合并为 U+XXXX-YYYY），超长折叠 */
function codepointsText(cps: number[], limit = 16): string {
  const ranges = normalizeRanges(cps.map((cp) => [cp, cp] as [number, number]));
  const { text, hidden } = formatRangesCompact(ranges, limit);
  return hidden > 0 ? `${text} 等 ${cps.length} 个码位` : text;
}

/**
 * 补字预算规划：为当前缺失的非自由字素簇规划假想的 (字体, 码位) 补字对。
 * 纯“what-if”面板 —— 不修改字体范围、回退链求解结果或任何审计数据；
 * 文本、字体、覆盖模式或预算变化时方案同步重算。
 */
export default function PatchPlannerPanel(props: PatchPlannerPanelProps) {
  const { clusters, validFonts, auditInput, generatedAt, scenarioNames } = props;
  /** 补字预算：最多可新增的不同 (字体, 码位) 对数 */
  const [budget, setBudget] = useState(16);

  const plan = useMemo(
    () => planPatchBudget({ clusters, validFonts, budget }),
    [clusters, validFonts, budget],
  );

  const fontName = (i: number) => validFonts[i]?.name || '(未命名)';
  const scenName = (id: string) => scenarioNames?.get(id) ?? '当前场景';

  const download = () => {
    const report = buildPatchPlanReport(
      auditInput,
      plan,
      validFonts,
      generatedAt,
      scenarioNames,
    );
    downloadText('font-fallback-patch-plan.json', JSON.stringify(report, null, 2));
  };

  return (
    <>
      <div className="patch-head">
        <h3>补字预算规划</h3>
        {plan.missingBefore > 0 && (
          <button className="btn small primary" onClick={download}>
            下载方案 JSON
          </button>
        )}
      </div>
      <p className="muted small">
        基于当前参与求解的场景与生效的{auditInput.useMeasuredCoverage ? '实测' : '声明'}
        覆盖，为缺失簇规划假想的 (字体, 码位) 补字对：簇内全部必需码位由同一有效字体的
        「已有覆盖 ∪ 补丁」承接即视为恢复；同字体同码位跨簇复用只计一次，不同字体分别计费。
        规划不修改字体范围与求解结果。
      </p>

      {plan.missingBefore === 0 ? (
        <div className="alert ok">✓ 当前没有缺失的非自由字素簇，无需补字。</div>
      ) : validFonts.length === 0 ? (
        <div className="alert bad">
          <strong>⚠ {plan.missingBefore} 个缺失簇，但没有有效字体可承接补丁</strong>
          <span className="alert-detail">请先在左侧添加范围有效的字体，再进行补字规划。</span>
        </div>
      ) : (
        <>
          <div className="patch-budget-row">
            <label className="patch-budget-label">
              补字预算（最多新增 (字体, 码位) 对数）
              <input
                className="patch-budget-input mono"
                type="number"
                min={0}
                step={1}
                value={budget}
                onChange={(e) =>
                  setBudget(Math.max(0, Math.floor(Number(e.target.value) || 0)))
                }
              />
            </label>
            <span
              className={`badge ${
                plan.stillMissingCount > 0 && plan.usedPairs >= plan.budget
                  ? 'bad'
                  : 'muted-badge'
              }`}
            >
              已用 {plan.usedPairs} / {plan.budget} 对
            </span>
          </div>

          <div className="patch-stat-grid">
            <div className="stat bad">
              <div className="stat-value">{plan.missingBefore}</div>
              <div className="stat-label">缺失簇</div>
            </div>
            <div className="stat ok">
              <div className="stat-value">{plan.restoredCount}</div>
              <div className="stat-label">预计恢复</div>
            </div>
            <div className={`stat${plan.stillMissingCount ? ' bad' : ''}`}>
              <div className="stat-value">{plan.stillMissingCount}</div>
              <div className="stat-label">仍缺失</div>
            </div>
            <div className="stat">
              <div className="stat-value">{plan.usedPairs}</div>
              <div className="stat-label">新增对数</div>
            </div>
          </div>

          {plan.stillMissingCount === 0 ? (
            <div className="alert ok">
              ✓ 预算内可恢复全部 {plan.missingBefore} 个缺失簇，共需 {plan.usedPairs}{' '}
              个 (字体, 码位) 对。
            </div>
          ) : plan.rounds.length === 0 ? (
            <div className="alert bad">
              <strong>预算内无法恢复任何缺失簇</strong>
              <span className="alert-detail">
                {plan.budget === 0
                  ? '预算为 0：请提高预算以规划补字。'
                  : `预算 ${plan.budget} 对不足以完成任何一簇的最小补丁，仍缺失 ${plan.stillMissingCount} 簇。`}
              </span>
            </div>
          ) : (
            <div className="alert bad">
              <strong>
                预计恢复 {plan.restoredCount} / {plan.missingBefore} 个缺失簇
              </strong>
              <span className="alert-detail">
                预算 {plan.budget} 对内已用 {plan.usedPairs} 对，仍缺失{' '}
                {plan.stillMissingCount} 簇 —— 可适当提高预算。
              </span>
            </div>
          )}

          <div className="patch-section">
            <div className="patch-section-title">逐场景预计恢复 / 仍缺失</div>
            <ul className="patch-scenario-list">
              {plan.scenarioStats.map((s) => (
                <li key={s.scenarioId}>
                  <span className="patch-scenario-name" title={scenName(s.scenarioId)}>
                    {scenName(s.scenarioId)}
                  </span>
                  <span className={`badge ${s.restored ? 'ok' : 'muted-badge'}`}>
                    预计恢复 {s.restored}
                  </span>
                  <span className={`badge ${s.stillMissing ? 'bad' : 'muted-badge'}`}>
                    仍缺失 {s.stillMissing}
                  </span>
                  <span className="muted small">（原缺失 {s.missingBefore} 簇）</span>
                </li>
              ))}
            </ul>
          </div>

          {plan.patchesByFont.length > 0 && (
            <div className="patch-section">
              <div className="patch-section-title">
                按字体归组的补码清单（合计 {plan.usedPairs} 对）
              </div>
              <ul className="patch-font-list">
                {plan.patchesByFont.map((g) => (
                  <li key={g.fontIndex}>
                    <span className="patch-font-name" title={fontName(g.fontIndex)}>
                      {fontName(g.fontIndex)}
                    </span>
                    <span className="badge muted-badge">{g.pairs} 对</span>
                    <span className="mono patch-cps">
                      {codepointsText(g.codepoints)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {plan.rounds.length > 0 && (
            <details className="risk-details patch-section">
              <summary>
                逐轮选择明细（{plan.rounds.length} 轮 · 按「恢复簇数 / 新增对数」贪心）
              </summary>
              <ul className="patch-round-list">
                {plan.rounds.slice(0, ROUND_LIMIT).map((r) => (
                  <li key={r.round}>
                    <span className="patch-round-num mono">#{r.round}</span>
                    <span
                      className="risk-scenario-tag"
                      title={`场景「${scenName(r.scenarioId)}」内 #${r.localIndex + 1}`}
                    >
                      {scenName(r.scenarioId)}
                    </span>
                    <span className="glyph-inline" title={r.clusterText}>
                      {displayCluster(r.clusterText)}
                    </span>
                    <span className="muted mono">#{r.localIndex + 1}</span>
                    <span className="risk-chain-arrow">→</span>
                    <span className="risk-chain-font">{fontName(r.fontIndex)}</span>
                    <span className="muted small">
                      +{r.addedPairs} 对（
                      {r.addedCodepoints.map(formatCodepoint).join(' ')}）· 新恢复{' '}
                      {r.restoredCount} 簇 · 比 {r.ratio.toFixed(2)} · 累计{' '}
                      {r.budgetUsedAfter}/{plan.budget}
                    </span>
                  </li>
                ))}
                {plan.rounds.length > ROUND_LIMIT && (
                  <li className="muted small">… 等 {plan.rounds.length} 轮（完整明细见方案 JSON）</li>
                )}
              </ul>
            </details>
          )}

          {plan.stillMissingCount > 0 && (
            <div className="patch-section">
              <div className="patch-section-title">
                预算内仍缺失（{plan.stillMissingCount} 簇）
              </div>
              <div className="risk-chips">
                {plan.unrecovered.slice(0, CHIP_LIMIT).map((c) => (
                  <span
                    key={`${c.scenarioId}:${c.index}`}
                    className="missing-chip"
                    title={`「${scenName(c.scenarioId)}」#${c.localIndex + 1} · ${c.required
                      .map(formatCodepoint)
                      .join(' ')}`}
                  >
                    {displayCluster(c.text)}
                  </span>
                ))}
                {plan.unrecovered.length > CHIP_LIMIT && (
                  <span className="muted small">等 {plan.unrecovered.length} 个</span>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
