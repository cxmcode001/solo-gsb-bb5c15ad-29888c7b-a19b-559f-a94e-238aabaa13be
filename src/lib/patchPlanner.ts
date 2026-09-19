/**
 * 补字预算规划。
 *
 * 在「不修改任何字体范围与求解结果」的前提下，为当前缺失的非自由字素簇
 * 规划假想的补字（patch）方案：向有效字体追加若干不同的 (字体, 码位) 对，
 * 使缺失簇的**全部必需码位**由同一有效字体的「已有覆盖 ∪ 补丁覆盖」承接，
 * 该簇即视为“预计恢复”。
 *
 * 计费规则：
 *   - 每个不同的 (字体, 码位) 对计 1；同字体同码位被多个簇复用只计一次；
 *   - 不同字体即使补同一码位也分别计费。
 *
 * 贪心选择：每轮枚举「当前仍缺失簇 × 有效字体」的最小补丁（该簇必需码位中
 * 此字体尚未覆盖、也尚未补的码位集合），按「新增恢复簇数 / 新增对数」比值
 * 选择；平局依次取较少新增对数、较前字体、较前场景/簇；只接受预算内方案，
 * 每轮结束后按最新补丁集合重新计算全部仍缺失簇的恢复状态。
 *
 * 索引约定：字体下标为「有效字体列表」下标（顺序即偏好顺序，越小越靠前）；
 * 簇下标为当前参与求解的簇展平后的全局下标（场景顺序 + 场景内顺序）。
 */

import type { ParsedFont, ScenarioClusterAudit } from '../types';
import { coversCodepoint } from './coverage';

/** 一轮贪心选择的结果 */
export interface PatchRound {
  /** 轮次（从 1 开始） */
  round: number;
  /** 目标缺失簇的全局展平下标 */
  clusterIndex: number;
  /** 目标簇所属场景 id */
  scenarioId: string;
  /** 目标簇在所属场景内的局部下标 */
  localIndex: number;
  /** 目标簇文本（原样） */
  clusterText: string;
  /** 接受补丁的有效字体下标 */
  fontIndex: number;
  /** 本轮新增的码位（升序、去重） */
  addedCodepoints: number[];
  /** 新增对数（= addedCodepoints.length） */
  addedPairs: number;
  /** 本轮新增恢复的簇数（目标簇 + 连带恢复的其它簇） */
  restoredCount: number;
  /** 新增恢复簇数 / 新增对数 */
  ratio: number;
  /** 本轮后累计已用对数 */
  budgetUsedAfter: number;
}

/** 按字体归组的补码清单条目 */
export interface FontPatchGroup {
  /** 有效字体下标 */
  fontIndex: number;
  /** 需补的码位（升序、去重） */
  codepoints: number[];
  /** 该字体的新增对数 */
  pairs: number;
}

/** 逐场景统计（仅含原本有缺失簇的参与场景，按场景顺序） */
export interface ScenarioPatchStats {
  scenarioId: string;
  /** 规划前该场景的缺失簇数 */
  missingBefore: number;
  /** 预算内预计恢复的簇数 */
  restored: number;
  /** 预算内仍缺失的簇数 */
  stillMissing: number;
}

/** 预算内仍无法恢复的簇 */
export interface UnrecoveredCluster {
  index: number;
  scenarioId: string;
  localIndex: number;
  text: string;
  /** 去重升序后的必需码位 */
  required: number[];
}

export interface PatchPlan {
  /** 生效预算（最多可新增的不同 (字体, 码位) 对数，已归一化为非负整数） */
  budget: number;
  /** 实际使用对数 */
  usedPairs: number;
  /** 规划前缺失的非自由簇总数 */
  missingBefore: number;
  /** 预算内预计恢复簇数 */
  restoredCount: number;
  /** 预算内仍缺失簇数 */
  stillMissingCount: number;
  /** 逐轮选择明细 */
  rounds: PatchRound[];
  /** 按字体归组的补码清单 */
  patchesByFont: FontPatchGroup[];
  /** 逐场景预计恢复/仍缺失统计 */
  scenarioStats: ScenarioPatchStats[];
  /** 预算内仍缺失的簇 */
  unrecovered: UnrecoveredCluster[];
}

export interface PatchPlanInput {
  /** 当前参与求解的簇（含场景归属，按全局展平顺序） */
  clusters: ScenarioClusterAudit[];
  /** 有效字体列表（effectiveRanges 已随声明/实测开关确定） */
  validFonts: ParsedFont[];
  /** 最多可新增的不同 (字体, 码位) 对数 */
  budget: number;
}

/**
 * 在预算内为缺失簇规划补字方案（纯函数，不修改任何输入）。
 * 返回的方案只描述“假想补丁”，不会改动字体范围或回退链求解结果。
 */
export function planPatchBudget(input: PatchPlanInput): PatchPlan {
  const { clusters, validFonts } = input;
  const budget = Math.max(
    0,
    Math.floor(Number.isFinite(input.budget) ? input.budget : 0),
  );

  // 当前缺失的非自由簇（status='missing' 必为非自由）；必需码位去重升序，
  // 保证 (字体, 码位) 对按“不同码位”计费（簇内重复码位不重复计费）。
  const missing = clusters
    .filter((c) => c.status === 'missing')
    .map((c) => ({
      index: c.index,
      scenarioId: c.scenarioId,
      localIndex: c.localIndex,
      text: c.text,
      need: [...new Set(c.required)].sort((a, b) => a - b),
    }));

  const fontRanges = validFonts.map((f) => f.effectiveRanges);
  // 每种字体已接受的补丁码位集合（同字体同码位跨簇复用只计一次）
  const patched: Set<number>[] = fontRanges.map(() => new Set<number>());
  // uncovered0[mi][fi]：簇 mi 的必需码位中，字体 fi 已有覆盖之外的部分（不含补丁）
  const uncovered0: number[][][] = missing.map((m) =>
    fontRanges.map((ranges) => m.need.filter((cp) => !coversCodepoint(ranges, cp))),
  );

  const restored = new Set<number>(); // missing 数组下标
  const rounds: PatchRound[] = [];
  let used = 0;

  /** 按当前补丁集合，簇 mi 是否可由字体 fi 单独承接 */
  const restorableVia = (mi: number, fi: number): boolean =>
    uncovered0[mi][fi].every((cp) => patched[fi].has(cp));

  for (;;) {
    let best: { mi: number; fi: number; newCps: number[]; gain: number } | null =
      null;

    // 枚举「仍缺失簇 × 有效字体」的最小补丁
    for (let mi = 0; mi < missing.length; mi++) {
      if (restored.has(mi)) continue;
      for (let fi = 0; fi < fontRanges.length; fi++) {
        const newCps = uncovered0[mi][fi].filter((cp) => !patched[fi].has(cp));
        const cost = newCps.length;
        if (cost === 0) continue; // 已可恢复（防御：正常不会进入）
        if (used + cost > budget) continue; // 只选择预算内方案

        // 新增恢复簇数：假设补上 newCps 后，当前仍缺失簇中可由字体 fi 承接的数量
        const add = new Set(newCps);
        let gain = 0;
        for (let mj = 0; mj < missing.length; mj++) {
          if (restored.has(mj)) continue;
          if (
            uncovered0[mj][fi].every(
              (cp) => patched[fi].has(cp) || add.has(cp),
            )
          ) {
            gain++;
          }
        }

        // 选择：比值（恢复/对数）大者优先；平局依次取较少新增对数、
        // 较前字体、较前场景/簇（全局下标即场景顺序 + 场景内顺序）。
        // 比值用交叉相乘比较，避免浮点误差。
        if (
          best === null ||
          gain * best.newCps.length > best.gain * cost ||
          (gain * best.newCps.length === best.gain * cost &&
            (cost < best.newCps.length ||
              (cost === best.newCps.length &&
                (fi < best.fi ||
                  (fi === best.fi &&
                    missing[mi].index < missing[best.mi].index)))))
        ) {
          best = { mi, fi, newCps, gain };
        }
      }
    }

    if (best === null) break;

    for (const cp of best.newCps) patched[best.fi].add(cp);
    used += best.newCps.length;

    // 每轮后重新计算恢复数：补丁集合更新后，重新判定全部仍缺失簇
    let newly = 0;
    for (let mj = 0; mj < missing.length; mj++) {
      if (restored.has(mj)) continue;
      for (let fj = 0; fj < fontRanges.length; fj++) {
        if (restorableVia(mj, fj)) {
          restored.add(mj);
          newly++;
          break;
        }
      }
    }

    const m = missing[best.mi];
    rounds.push({
      round: rounds.length + 1,
      clusterIndex: m.index,
      scenarioId: m.scenarioId,
      localIndex: m.localIndex,
      clusterText: m.text,
      fontIndex: best.fi,
      addedCodepoints: best.newCps,
      addedPairs: best.newCps.length,
      restoredCount: newly,
      ratio: newly / best.newCps.length,
      budgetUsedAfter: used,
    });
  }

  // 按字体归组的补码清单（按字体顺序）
  const patchesByFont: FontPatchGroup[] = [];
  patched.forEach((set, fi) => {
    if (set.size > 0) {
      const codepoints = [...set].sort((a, b) => a - b);
      patchesByFont.push({ fontIndex: fi, codepoints, pairs: codepoints.length });
    }
  });

  // 逐场景统计（按簇出现顺序，即场景顺序）
  const statsMap = new Map<string, ScenarioPatchStats>();
  missing.forEach((m, mi) => {
    let st = statsMap.get(m.scenarioId);
    if (!st) {
      st = { scenarioId: m.scenarioId, missingBefore: 0, restored: 0, stillMissing: 0 };
      statsMap.set(m.scenarioId, st);
    }
    st.missingBefore++;
    if (restored.has(mi)) st.restored++;
    else st.stillMissing++;
  });

  const unrecovered: UnrecoveredCluster[] = [];
  missing.forEach((m, mi) => {
    if (!restored.has(mi)) {
      unrecovered.push({
        index: m.index,
        scenarioId: m.scenarioId,
        localIndex: m.localIndex,
        text: m.text,
        required: m.need,
      });
    }
  });

  return {
    budget,
    usedPairs: used,
    missingBefore: missing.length,
    restoredCount: restored.size,
    stillMissingCount: missing.length - restored.size,
    rounds,
    patchesByFont,
    scenarioStats: [...statsMap.values()],
    unrecovered,
  };
}
