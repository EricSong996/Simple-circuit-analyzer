import type {
  Branch,
  BranchCS,
  CurrentProbe,
  SolveErr,
  SolveResult,
  VoltageProbe,
} from './types'

function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length
  if (n === 0) return []
  const M = A.map((row, i) => [...row, b[i]])

  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    }
    if (Math.abs(M[piv][col]) < 1e-12) return null
    if (piv !== col) {
      const tmp = M[col]
      M[col] = M[piv]
      M[piv] = tmp
    }
    const div = M[col][col]
    for (let c = col; c <= n; c++) M[col][c] /= div
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = M[r][col]
      if (Math.abs(f) < 1e-18) continue
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c]
    }
  }

  return M.map((row) => row[n])
}

function trimLb(s: string): string {
  return s.trim()
}

function vpNodeForLabel(label: string, vps: VoltageProbe[]): number | null {
  const t = trimLb(label)
  if (!t) return null
  const p = vps.find((v) => trimLb(v.label) === t)
  return p ? p.nodeId : null
}

function branchIndexForCurrentProbe(
  label: string,
  branches: Branch[],
  cps: CurrentProbe[]
): number | null {
  const t = trimLb(label)
  if (!t) return null
  const p = cps.find((q) => trimLb(q.label) === t)
  if (!p) return null
  const j = branches.findIndex((b) => b.id === p.targetBranchId)
  return j >= 0 ? j : null
}

function branchNeedsVoltageAux(b: Branch): boolean {
  if (b.kind === 'V' || b.kind === 'W') return true
  if (b.kind === 'CS' && b.output === 'V') return true
  return false
}

type VoltRow =
  | { kind: 'const'; np: number; nm: number; v: number }
  | { kind: 'vcvs'; np: number; nm: number; k: number; n1: number; n2: number }
  | { kind: 'ccvs_aux'; np: number; nm: number; k: number; ctrlSlot: number }

/**
 * 压控电流源：经支路内部从 from→to 的电流 I = gm*(V(n1)-V(n2))。
 * 仅在对应 KCL 行上填跨导项（不得对称误填 A[n1][from]，否则破坏 KCL）。
 */
function stampTransconductance(
  A: number[][],
  refNode: number,
  colOfNode: number[],
  from: number,
  to: number,
  n1: number,
  n2: number,
  gm: number
) {
  const add = (rowNode: number, colNode: number, val: number) => {
    if (rowNode === refNode || colNode === refNode) return
    const r = colOfNode[rowNode]
    const c = colOfNode[colNode]
    A[r][c] += val
  }
  add(from, n1, gm)
  add(from, n2, -gm)
  add(to, n1, -gm)
  add(to, n2, gm)
}

function stampAuxCoupling(
  A: number[][],
  refNode: number,
  colOfNode: number[],
  nv: number,
  from: number,
  to: number,
  vsSlot: number,
  coeff: number
) {
  const colI = nv + vsSlot
  if (from !== refNode) {
    const cf = colOfNode[from]
    A[cf][colI] -= coeff
    A[colI][cf] -= coeff
  }
  if (to !== refNode) {
    const ct = colOfNode[to]
    A[ct][colI] += coeff
    A[colI][ct] += coeff
  }
}

type CccsFlat =
  | { tag: 'tg'; n1: number; n2: number; gm: number }
  | { tag: 'rhs'; i: number }
  | { tag: 'aux'; slot: number; c: number }

function flattenCccsToParts(
  branches: Branch[],
  vps: VoltageProbe[],
  cps: CurrentProbe[],
  branchToSlot: Map<number, number>,
  label: string,
  kAccum: number,
  stack: Set<number>
): SolveErr | CccsFlat[] {
  const t = trimLb(label)
  if (!t) return { ok: false, message: '受控源缺少电流探针代号。' }
  const bi = branchIndexForCurrentProbe(t, branches, cps)
  if (bi === null) {
    return {
      ok: false,
      message: `找不到代号「${t}」对应的电流探针，或探针未挂在支路上。`,
    }
  }
  const b = branches[bi]!
  if (b.kind === 'R') {
    return [{ tag: 'tg', n1: b.n1, n2: b.n2, gm: kAccum / b.ohms }]
  }
  if (b.kind === 'I') {
    return [{ tag: 'rhs', i: kAccum * b.amps }]
  }
  if (b.kind === 'V' || b.kind === 'W') {
    const slot = branchToSlot.get(bi)
    if (slot === undefined)
      return { ok: false, message: '内部错误：电压型支路缺少辅助电流槽位。' }
    return [{ tag: 'aux', slot, c: kAccum }]
  }
  if (b.kind === 'CS' && b.output === 'V') {
    const slot = branchToSlot.get(bi)
    if (slot === undefined)
      return { ok: false, message: '内部错误：受控电压支路缺少辅助电流槽位。' }
    return [{ tag: 'aux', slot, c: kAccum }]
  }
  if (b.kind === 'CS' && b.output === 'I') {
    if (stack.has(bi)) {
      return { ok: false, message: '流控支路形成环路，无法求解。' }
    }
    stack.add(bi)
    if (b.control === 'volt') {
      const n1 = vpNodeForLabel(b.vProbeLabelPlus, vps)
      const n2 = vpNodeForLabel(b.vProbeLabelMinus, vps)
      if (n1 === null || n2 === null) {
        return { ok: false, message: '内层压控受控电流源缺少有效电压探针。' }
      }
      stack.delete(bi)
      return [{ tag: 'tg', n1, n2, gm: kAccum * b.k }]
    }
    const inner = flattenCccsToParts(
      branches,
      vps,
      cps,
      branchToSlot,
      b.iProbeLabel,
      kAccum * b.k,
      stack
    )
    stack.delete(bi)
    return inner
  }
  return { ok: false, message: '不支持的流控受控源控制支路类型。' }
}

type CcvsFlat =
  | { tag: 'vcvs'; k: number; n1: number; n2: number }
  | { tag: 'ccvs_aux'; k: number; ctrlSlot: number }
  | { tag: 'const'; v: number }
  | { tag: 'ccvs_r'; k: number; n1: number; n2: number; r: number }

function flattenCcvsToRow(
  branches: Branch[],
  vps: VoltageProbe[],
  cps: CurrentProbe[],
  branchToSlot: Map<number, number>,
  label: string,
  kAccum: number,
  stack: Set<number>
): SolveErr | CcvsFlat {
  const t = trimLb(label)
  if (!t) return { ok: false, message: '受控源缺少电流探针代号。' }
  const bi = branchIndexForCurrentProbe(t, branches, cps)
  if (bi === null) {
    return {
      ok: false,
      message: `找不到代号「${t}」对应的电流探针，或探针未挂在支路上。`,
    }
  }
  const b = branches[bi]!
  if (b.kind === 'R') {
    return { tag: 'ccvs_r', k: kAccum, n1: b.n1, n2: b.n2, r: b.ohms }
  }
  if (b.kind === 'I') {
    return { tag: 'const', v: kAccum * b.amps }
  }
  if (b.kind === 'V' || b.kind === 'W') {
    const slot = branchToSlot.get(bi)
    if (slot === undefined)
      return { ok: false, message: '内部错误：电压型支路缺少辅助电流槽位。' }
    return { tag: 'ccvs_aux', k: kAccum, ctrlSlot: slot }
  }
  if (b.kind === 'CS' && b.output === 'V') {
    const slot = branchToSlot.get(bi)
    if (slot === undefined)
      return { ok: false, message: '内部错误：受控电压支路缺少辅助电流槽位。' }
    return { tag: 'ccvs_aux', k: kAccum, ctrlSlot: slot }
  }
  if (b.kind === 'CS' && b.output === 'I') {
    if (stack.has(bi)) return { ok: false, message: '流控支路形成环路，无法求解。' }
    stack.add(bi)
    if (b.control === 'volt') {
      const n1 = vpNodeForLabel(b.vProbeLabelPlus, vps)
      const n2 = vpNodeForLabel(b.vProbeLabelMinus, vps)
      if (n1 === null || n2 === null) {
        return { ok: false, message: '内层压控受控电流源缺少有效电压探针。' }
      }
      stack.delete(bi)
      return { tag: 'vcvs', k: kAccum * b.k, n1, n2 }
    }
    const inner = flattenCcvsToRow(
      branches,
      vps,
      cps,
      branchToSlot,
      b.iProbeLabel,
      kAccum * b.k,
      stack
    )
    stack.delete(bi)
    return inner
  }
  return { ok: false, message: '不支持的 CCVS 控制支路类型。' }
}

function validateCsBranch(
  b: BranchCS,
  branches: Branch[],
  vps: VoltageProbe[],
  cps: CurrentProbe[]
): SolveErr | null {
  if (!Number.isFinite(b.k)) {
    return { ok: false, message: `受控源 k 无效（支路 ${b.id}）。` }
  }
  if (b.control === 'volt') {
    const n1 = vpNodeForLabel(b.vProbeLabelPlus, vps)
    const n2 = vpNodeForLabel(b.vProbeLabelMinus, vps)
    if (n1 === null || n2 === null) {
      return {
        ok: false,
        message: `受控源 ${b.id}：电压探针代号无效或未放置。`,
      }
    }
  } else {
    const bi = branchIndexForCurrentProbe(b.iProbeLabel, branches, cps)
    if (bi === null) {
      return {
        ok: false,
        message: `受控源 ${b.id}：电流探针代号无效或未放置。`,
      }
    }
  }
  return null
}

/**
 * 用已求得的支路电流（与 types 中约定方向一致）检验各节点 KCL：
 * 约定「流出节点为正」，对每个节点求 Σ I_out，理想应为 0。
 * 返回所有节点残差绝对值的最大值（含参考节点）。
 */
export function largestKclResidualAbs(
  numNodes: number,
  _refNode: number,
  branches: Branch[],
  branchCurrents: number[]
): number {
  const r = new Array(numNodes).fill(0)
  for (let j = 0; j < branches.length; j++) {
    const I = branchCurrents[j]!
    if (!Number.isFinite(I)) continue
    const b = branches[j]!
    if (b.kind === 'R') {
      r[b.n1] += I
      r[b.n2] -= I
    } else if (b.kind === 'V' || (b.kind === 'CS' && b.output === 'V')) {
      r[b.nPlus] += I
      r[b.nMinus] -= I
    } else if (b.kind === 'W') {
      r[b.n1] += I
      r[b.n2] -= I
    } else if (b.kind === 'I') {
      r[b.nFrom] += I
      r[b.nTo] -= I
    } else if (b.kind === 'CS' && b.output === 'I') {
      r[b.nPlus] += I
      r[b.nMinus] -= I
    }
  }
  let m = 0
  for (let i = 0; i < numNodes; i++) {
    const a = Math.abs(r[i])
    if (a > m) m = a
  }
  return m
}

/**
 * 直流 MNA：电阻、独立 V/I、导线（0V 源）、受控源（VCVS / VCCS / CCCS / CCVS）。
 * 含受控源时必须传入 opts 中的探针列表（与 branches 同一紧凑编号空间）。
 */
export function solveDcMna(
  numNodes: number,
  refNode: number,
  branches: Branch[],
  opts?: { voltageProbes?: VoltageProbe[]; currentProbes?: CurrentProbe[] }
): SolveResult {
  const vps = opts?.voltageProbes ?? []
  const cps = opts?.currentProbes ?? []

  if (numNodes < 1) {
    return { ok: false, message: '没有节点。' }
  }
  if (refNode < 0 || refNode >= numNodes) {
    return { ok: false, message: '参考节点（地）无效。' }
  }

  for (const b of branches) {
    if (b.kind === 'CS') {
      const e = validateCsBranch(b, branches, vps, cps)
      if (e) return e
    }
  }

  const branchToSlot = new Map<number, number>()
  let vsCount = 0
  for (let j = 0; j < branches.length; j++) {
    if (branchNeedsVoltageAux(branches[j]!)) {
      branchToSlot.set(j, vsCount++)
    }
  }

  const resistors: { n1: number; n2: number; g: number }[] = []
  const currents: { from: number; to: number; i: number }[] = []
  const voltRows: VoltRow[] = []
  const vccsList: { from: number; to: number; n1: number; n2: number; gm: number }[] =
    []
  const cccsList: { from: number; to: number; parts: CccsFlat[] }[] = []

  for (let j = 0; j < branches.length; j++) {
    const b = branches[j]!
    if (b.kind === 'R') {
      if (b.ohms <= 0 || !Number.isFinite(b.ohms)) {
        return { ok: false, message: `电阻必须为正数（支路 ${b.id}）。` }
      }
      resistors.push({ n1: b.n1, n2: b.n2, g: 1 / b.ohms })
    } else if (b.kind === 'V') {
      if (!Number.isFinite(b.volts)) {
        return { ok: false, message: `电压源数值无效（支路 ${b.id}）。` }
      }
      voltRows.push({ kind: 'const', np: b.nPlus, nm: b.nMinus, v: b.volts })
    } else if (b.kind === 'W') {
      voltRows.push({ kind: 'const', np: b.n1, nm: b.n2, v: 0 })
    } else if (b.kind === 'I') {
      if (!Number.isFinite(b.amps)) {
        return { ok: false, message: `电流源数值无效（支路 ${b.id}）。` }
      }
      currents.push({ from: b.nFrom, to: b.nTo, i: b.amps })
    } else if (b.kind === 'CS') {
      const np = b.nPlus
      const nm = b.nMinus
      if (b.output === 'V' && b.control === 'volt') {
        const n1 = vpNodeForLabel(b.vProbeLabelPlus, vps)!
        const n2 = vpNodeForLabel(b.vProbeLabelMinus, vps)!
        voltRows.push({ kind: 'vcvs', np, nm, k: b.k, n1, n2 })
      } else if (b.output === 'V' && b.control === 'curr') {
        const fr = flattenCcvsToRow(
          branches,
          vps,
          cps,
          branchToSlot,
          b.iProbeLabel,
          b.k,
          new Set()
        )
        if ('ok' in fr && fr.ok === false) return fr
        const r = fr as CcvsFlat
        if (r.tag === 'const') {
          voltRows.push({ kind: 'const', np, nm, v: r.v })
        } else if (r.tag === 'vcvs') {
          voltRows.push({
            kind: 'vcvs',
            np,
            nm,
            k: r.k,
            n1: r.n1,
            n2: r.n2,
          })
        } else if (r.tag === 'ccvs_r') {
          voltRows.push({
            kind: 'vcvs',
            np,
            nm,
            k: r.k / r.r,
            n1: r.n1,
            n2: r.n2,
          })
        } else {
          voltRows.push({
            kind: 'ccvs_aux',
            np,
            nm,
            k: r.k,
            ctrlSlot: r.ctrlSlot,
          })
        }
      } else if (b.output === 'I' && b.control === 'volt') {
        const n1 = vpNodeForLabel(b.vProbeLabelPlus, vps)!
        const n2 = vpNodeForLabel(b.vProbeLabelMinus, vps)!
        vccsList.push({ from: np, to: nm, n1, n2, gm: b.k })
      } else {
        const parts = flattenCccsToParts(
          branches,
          vps,
          cps,
          branchToSlot,
          b.iProbeLabel,
          b.k,
          new Set()
        )
        if ('ok' in parts && parts.ok === false) return parts
        cccsList.push({ from: np, to: nm, parts: parts as CccsFlat[] })
      }
    }
  }

  if (voltRows.length !== vsCount) {
    return {
      ok: false,
      message: '内部错误：电压辅助支路数量与矩阵不一致。',
    }
  }

  const nv = numNodes - 1
  const nvs = voltRows.length
  const n = nv + nvs
  if (n === 0) {
    return { ok: false, message: '没有未知量可解。' }
  }

  const colOfNode: number[] = new Array(numNodes)
  let c = 0
  for (let i = 0; i < numNodes; i++) {
    if (i === refNode) colOfNode[i] = -1
    else colOfNode[i] = c++
  }
  if (c !== nv) return { ok: false, message: '内部错误：节点映射不一致。' }

  const A: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  const rhs: number[] = new Array(n).fill(0)

  const addG = (p: number, q: number, g: number) => {
    if (p !== refNode) {
      const cp = colOfNode[p]
      A[cp][cp] += g
      if (q !== refNode) {
        const cq = colOfNode[q]
        A[cp][cq] -= g
      }
    }
    if (q !== refNode) {
      const cq = colOfNode[q]
      A[cq][cq] += g
      if (p !== refNode) {
        const cp = colOfNode[p]
        A[cq][cp] -= g
      }
    }
  }

  for (const { n1, n2, g } of resistors) {
    addG(n1, n2, g)
  }

  for (const { from, to, i } of currents) {
    if (from !== refNode) rhs[colOfNode[from]] -= i
    if (to !== refNode) rhs[colOfNode[to]] += i
  }

  for (const tg of vccsList) {
    stampTransconductance(
      A,
      refNode,
      colOfNode,
      tg.from,
      tg.to,
      tg.n1,
      tg.n2,
      tg.gm
    )
  }

  for (const cc of cccsList) {
    for (const p of cc.parts) {
      if (p.tag === 'tg') {
        stampTransconductance(
          A,
          refNode,
          colOfNode,
          cc.from,
          cc.to,
          p.n1,
          p.n2,
          p.gm
        )
      } else if (p.tag === 'rhs') {
        if (cc.from !== refNode) rhs[colOfNode[cc.from]] -= p.i
        if (cc.to !== refNode) rhs[colOfNode[cc.to]] += p.i
      } else {
        stampAuxCoupling(
          A,
          refNode,
          colOfNode,
          nv,
          cc.from,
          cc.to,
          p.slot,
          p.c
        )
      }
    }
  }

  const stampVPair = (rowV: number, node: number, coeff: number) => {
    if (node === refNode) return
    const col = colOfNode[node]
    A[rowV][col] += coeff
    A[col][rowV] += coeff
  }

  for (let k = 0; k < nvs; k++) {
    const rowV = nv + k
    const row = voltRows[k]!
    if (row.kind === 'const') {
      const { np, nm, v } = row
      stampVPair(rowV, np, 1)
      stampVPair(rowV, nm, -1)
      rhs[rowV] = v
    } else if (row.kind === 'vcvs') {
      const { np, nm, k: kk, n1, n2 } = row
      stampVPair(rowV, np, 1)
      stampVPair(rowV, nm, -1)
      stampVPair(rowV, n1, -kk)
      stampVPair(rowV, n2, kk)
      rhs[rowV] = 0
    } else {
      const { np, nm, k: kk, ctrlSlot } = row
      stampVPair(rowV, np, 1)
      stampVPair(rowV, nm, -1)
      const colI = nv + ctrlSlot
      A[rowV][colI] -= kk
      A[colI][rowV] -= kk
      rhs[rowV] = 0
    }
  }

  const x = solveLinear(A, rhs)
  if (!x) {
    return {
      ok: false,
      message:
        '矩阵奇异或接近奇异，无法求解。请检查：是否接地、是否有悬空节点、理想源是否构成非法回路等。',
    }
  }

  const nodeV: number[] = new Array(numNodes)
  for (let i = 0; i < numNodes; i++) {
    if (i === refNode) nodeV[i] = 0
    else nodeV[i] = x[colOfNode[i]]
  }

  const branchCurrents: number[] = new Array(branches.length)
  let vk = 0
  for (let j = 0; j < branches.length; j++) {
    const b = branches[j]!
    if (b.kind === 'R') {
      branchCurrents[j] = (nodeV[b.n1] - nodeV[b.n2]) / b.ohms
    } else if (b.kind === 'V' || b.kind === 'W') {
      branchCurrents[j] = x[nv + vk]
      vk++
    } else if (b.kind === 'I') {
      branchCurrents[j] = b.amps
    } else {
      const bs = b as BranchCS
      if (bs.output === 'V') {
        branchCurrents[j] = x[nv + vk]
        vk++
      } else if (bs.control === 'volt') {
        const n1 = vpNodeForLabel(bs.vProbeLabelPlus, vps)!
        const n2 = vpNodeForLabel(bs.vProbeLabelMinus, vps)!
        branchCurrents[j] = bs.k * (nodeV[n1] - nodeV[n2])
      } else {
        let kk = bs.k
        let ti = branchIndexForCurrentProbe(bs.iProbeLabel, branches, cps)
        const guard = new Set<number>()
        while (ti !== null) {
          if (guard.has(ti)) {
            branchCurrents[j] = NaN
            break
          }
          guard.add(ti)
          const tb = branches[ti]!
          if (tb.kind === 'CS' && tb.output === 'I' && tb.control === 'curr') {
            kk *= tb.k
            ti = branchIndexForCurrentProbe(tb.iProbeLabel, branches, cps)
          } else {
            branchCurrents[j] = kk * branchCurrents[ti]!
            ti = null
          }
        }
      }
    }
  }

  let scale = 1
  for (const v of nodeV) {
    if (Number.isFinite(v)) scale = Math.max(scale, Math.abs(v))
  }
  for (const c of branchCurrents) {
    if (Number.isFinite(c)) scale = Math.max(scale, Math.abs(c))
  }
  const kclTol = 1e-7 * scale + 1e-10
  const kclMax = largestKclResidualAbs(
    numNodes,
    refNode,
    branches,
    branchCurrents
  )
  if (kclMax > kclTol) {
    return {
      ok: false,
      message: `内部数值校验失败：节点 KCL 残差过大（最大约 ${kclMax.toExponential(2)}）。请反馈电路拓扑。`,
    }
  }

  return { ok: true, nodeV, branchCurrents }
}

export function nodesUsedInBranches(branches: Branch[]): Set<number> {
  const s = new Set<number>()
  for (const b of branches) {
    if (b.kind === 'R' || b.kind === 'W') {
      s.add(b.n1)
      s.add(b.n2)
    } else if (b.kind === 'V' || b.kind === 'CS') {
      s.add(b.nPlus)
      s.add(b.nMinus)
    } else {
      s.add(b.nFrom)
      s.add(b.nTo)
    }
  }
  return s
}

export function validateBeforeSolve(
  numNodes: number,
  groundId: number | null,
  branches: Branch[]
): SolveErr | null {
  if (branches.length === 0) {
    return {
      ok: false,
      message: '请至少添加一条支路（电阻、电源、导线或受控源）。',
    }
  }
  if (groundId === null) {
    return { ok: false, message: '请先使用「接地」工具选择一个参考节点（地）。' }
  }
  const used = nodesUsedInBranches(branches)
  if (!used.has(groundId)) {
    return { ok: false, message: '接地节点必须与某条支路相连。' }
  }
  if (used.size === 0) {
    return { ok: false, message: '没有有效支路。' }
  }
  const maxN = Math.max(...used, groundId)
  if (maxN >= numNodes) {
    return { ok: false, message: '内部错误：节点编号越界。' }
  }
  return null
}
