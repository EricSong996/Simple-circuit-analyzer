import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { branchEndpoints, compactCircuit } from './circuit/graphUtils'
import {
  nodesUsedInBranches,
  solveDcMna,
  validateBeforeSolve,
} from './circuit/solver'
import type {
  Branch,
  BranchCS,
  BranchI,
  BranchR,
  BranchV,
  BranchW,
  CurrentProbe,
  SolveErr,
  SolveOk,
  VoltageProbe,
} from './circuit/types'
import './App.css'

type Tool =
  | 'select'
  | 'node'
  | 'R'
  | 'V'
  | 'I'
  | 'cSource'
  | 'wire'
  | 'probe'
  | 'voltProbe'
  | 'gnd'

const MAX_CIRCUIT_UNDO = 60

/** 中间可拖动排序的工具（「编辑」「撤回」位置固定，不参与排序） */
type DraggableToolbarTool = Exclude<Tool, 'select'>

const DEFAULT_TOOLBAR_TOOL_ORDER: DraggableToolbarTool[] = [
  'node',
  'R',
  'V',
  'I',
  'cSource',
  'wire',
  'probe',
  'voltProbe',
  'gnd',
]

const TOOL_LABELS: Record<Tool, string> = {
  select: '编辑',
  node: '节点',
  R: '电阻',
  V: '电压源',
  I: '电流源',
  cSource: '受控源',
  wire: '导线',
  probe: '电流探针',
  voltProbe: '电压探针',
  gnd: '接地',
}

type CircuitSnapshot = {
  branches: Branch[]
  positions: Map<number, { x: number; y: number }>
  groundId: number | null
  nextId: number
  probes: CurrentProbe[]
  voltageProbes: VoltageProbe[]
}

function cloneCircuitSnapshot(
  branches: Branch[],
  positions: Map<number, { x: number; y: number }>,
  groundId: number | null,
  nextId: number,
  probes: CurrentProbe[],
  voltageProbes: VoltageProbe[]
): CircuitSnapshot {
  return {
    branches: structuredClone(branches) as Branch[],
    positions: new Map(
      [...positions.entries()].map(([id, pt]) => [id, { x: pt.x, y: pt.y }])
    ),
    groundId,
    nextId,
    probes: probes.map((p) => ({ ...p })),
    voltageProbes: voltageProbes.map((v) => ({ ...v })),
  }
}

/** 多画板：单页持久数据（电路 + 求解态 + 撤回栈） */
type TabPersist = {
  id: string
  name: string
  circuit: CircuitSnapshot
  solved: SolveOk | null
  error: string | null
  pruneMsg: string | null
  undoStack: CircuitSnapshot[]
}

function emptyCircuitSnapshot(): CircuitSnapshot {
  return {
    branches: [],
    positions: new Map(),
    groundId: null,
    nextId: 0,
    probes: [],
    voltageProbes: [],
  }
}

function cloneUndoStack(stack: CircuitSnapshot[]): CircuitSnapshot[] {
  return stack.map((s) =>
    cloneCircuitSnapshot(
      s.branches,
      s.positions,
      s.groundId,
      s.nextId,
      s.probes,
      s.voltageProbes
    )
  )
}

function buildFlushedTabsList(
  prev: TabPersist[],
  activeId: string,
  circuitSnap: CircuitSnapshot,
  solved: SolveOk | null,
  error: string | null,
  pruneMsg: string | null,
  undoStack: CircuitSnapshot[]
): TabPersist[] {
  const circ = cloneCircuitSnapshot(
    circuitSnap.branches,
    circuitSnap.positions,
    circuitSnap.groundId,
    circuitSnap.nextId,
    circuitSnap.probes,
    circuitSnap.voltageProbes
  )
  const us = cloneUndoStack(undoStack)
  return prev.map((t) =>
    t.id === activeId
      ? {
          ...t,
          circuit: circ,
          solved: solved ? (structuredClone(solved) as SolveOk) : null,
          error,
          pruneMsg,
          undoStack: us,
        }
      : t
  )
}

/**
 * 拖拽重排：按指针落在目标项左/右半边决定插入点。返回 null 表示顺序不变。
 */
function reorderDraggableIdsDuringDrag<T extends string>(
  list: T[],
  dragId: T,
  hoverId: T,
  placeAfter: boolean
): T[] | null {
  const fromIdx = list.findIndex((id) => id === dragId)
  if (fromIdx < 0) return null
  const dragItem = list[fromIdx]!
  const rest = list.filter((id) => id !== dragId)
  let insertAt: number
  if (dragId !== hoverId) {
    const ins = rest.findIndex((id) => id === hoverId)
    if (ins < 0) return null
    insertAt = placeAfter ? ins + 1 : ins
  } else {
    insertAt = placeAfter ? fromIdx + 1 : fromIdx
  }
  insertAt = Math.max(0, Math.min(insertAt, rest.length))
  const next = [...rest.slice(0, insertAt), dragItem, ...rest.slice(insertAt)]
  const same =
    next.length === list.length && next.every((id, i) => id === list[i])
  return same ? null : next
}

/**
 * 拖拽经过某标签时实时重排：按指针落在该标签左/右半边，决定插入点（与 Chromium / Edge 标签栏一致）。
 * 返回 null 表示顺序不变。
 */
function reorderTabsDuringDrag(
  list: TabPersist[],
  dragId: string,
  hoverTabId: string,
  placeAfter: boolean
): TabPersist[] | null {
  const ids = list.map((t) => t.id)
  const nextIds = reorderDraggableIdsDuringDrag(
    ids,
    dragId,
    hoverTabId,
    placeAfter
  )
  if (!nextIds) return null
  const byId = new Map(list.map((t) => [t.id, t]))
  return nextIds.map((id) => byId.get(id)!)
}

function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function applyCompact(
  branches: Branch[],
  positions: Map<number, { x: number; y: number }>,
  groundId: number | null
) {
  const c = compactCircuit(branches, positions.keys(), groundId)
  const newPos = new Map<number, { x: number; y: number }>()
  c.idMap.forEach((neu, old) => {
    const pt = positions.get(old)
    if (pt) newPos.set(neu, pt)
  })
  return {
    branches: c.branches,
    positions: newPos,
    groundId: c.groundId,
    nextId: c.inverseSize,
    idMap: c.idMap,
  }
}

function pruneOrphans(
  positions: Map<number, { x: number; y: number }>,
  branches: Branch[]
) {
  const used = nodesUsedInBranches(branches)
  const next = new Map(positions)
  for (const id of [...next.keys()]) {
    if (!used.has(id)) next.delete(id)
  }
  return next
}

function dist2(
  ax: number,
  ay: number,
  bx: number,
  by: number
) {
  const dx = ax - bx
  const dy = ay - by
  return dx * dx + dy * dy
}

function nearestNode(
  positions: Map<number, { x: number; y: number }>,
  x: number,
  y: number,
  r: number
): number | null {
  let best: number | null = null
  let bestD = r * r
  positions.forEach((p, id) => {
    const d = dist2(x, y, p.x, p.y)
    if (d <= bestD) {
      bestD = d
      best = id
    }
  })
  return best
}

function svgPoint(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number
): { x: number; y: number } {
  const pt = svg.createSVGPoint()
  pt.x = clientX
  pt.y = clientY
  const ctm = svg.getScreenCTM()
  if (!ctm) return { x: clientX, y: clientY }
  const p = pt.matrixTransform(ctm.inverse())
  return { x: p.x, y: p.y }
}

type NormRect = { x: number; y: number; w: number; h: number }

function normalizeSvgRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number
): NormRect {
  const x = Math.min(x0, x1)
  const y = Math.min(y0, y1)
  return { x, y, w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }
}

function pointInNormRect(px: number, py: number, r: NormRect): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h
}

/** Liang–Barsky：线段与轴对齐矩形是否有可见交集 */
function segmentIntersectsNormRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  r: NormRect
): boolean {
  const xmin = r.x
  const ymin = r.y
  const xmax = r.x + r.w
  const ymax = r.y + r.h
  let t0 = 0
  let t1 = 1
  const dx = x2 - x1
  const dy = y2 - y1
  const p = [-dx, dx, -dy, dy]
  const q = [x1 - xmin, xmax - x1, y1 - ymin, ymax - y1]
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]!) < 1e-12) {
      if (q[i]! < 0) return false
    } else {
      const t = q[i]! / p[i]!
      if (p[i]! < 0) {
        if (t > t1) return false
        if (t > t0) t0 = t
      } else {
        if (t < t0) return false
        if (t < t1) t1 = t
      }
    }
  }
  return t0 <= t1
}

function mid(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function resistorPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number
): string {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const px = -uy
  const py = ux
  const zig = 8
  const n = 4
  const start = 24
  const end = len - 24
  if (end <= start + 10) {
    return `M ${x1} ${y1} L ${x2} ${y2}`
  }
  let d = `M ${x1 + ux * 20} ${y1 + uy * 20}`
  const step = (end - start) / n
  for (let i = 0; i <= n; i++) {
    const t = start + i * step
    const s = i % 2 === 0 ? 1 : -1
    const x = x1 + ux * t + px * zig * s
    const y = y1 + uy * t + py * zig * s
    d += ` L ${x} ${y}`
  }
  d += ` L ${x2 - ux * 20} ${y2 - uy * 20}`
  return d
}

/** 与电阻折线几何一致，用于命中检测 */
function resistorPolyline(
  x1: number,
  y1: number,
  x2: number,
  y2: number
): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = []
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const px = -uy
  const py = ux
  const zig = 8
  const n = 4
  const start = 24
  const end = len - 24
  pts.push({ x: x1, y: y1 })
  if (end <= start + 10) {
    pts.push({ x: x2, y: y2 })
    return pts
  }
  pts.push({ x: x1 + ux * 20, y: y1 + uy * 20 })
  const step = (end - start) / n
  for (let i = 0; i <= n; i++) {
    const t = start + i * step
    const s = i % 2 === 0 ? 1 : -1
    pts.push({
      x: x1 + ux * t + px * zig * s,
      y: y1 + uy * t + py * zig * s,
    })
  }
  pts.push({ x: x2 - ux * 20, y: y2 - uy * 20 })
  pts.push({ x: x2, y: y2 })
  return pts
}

function pointSegmentDistanceSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const abx = bx - ax
  const aby = by - ay
  const apx = px - ax
  const apy = py - ay
  const ab2 = abx * abx + aby * aby || 1
  let t = (apx * abx + apy * aby) / ab2
  t = Math.max(0, Math.min(1, t))
  const qx = ax + abx * t
  const qy = ay + aby * t
  const dx = px - qx
  const dy = py - qy
  return dx * dx + dy * dy
}

/** 线段上距 (px,py) 最近的点 */
function closestPointOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): { x: number; y: number } {
  const abx = bx - ax
  const aby = by - ay
  const apx = px - ax
  const apy = py - ay
  const ab2 = abx * abx + aby * aby || 1
  let t = (apx * abx + apy * aby) / ab2
  t = Math.max(0, Math.min(1, t))
  return { x: ax + abx * t, y: ay + aby * t }
}

function minDistToPolyline(
  px: number,
  py: number,
  pts: Array<{ x: number; y: number }>
): number {
  let best = Infinity
  for (let i = 0; i < pts.length - 1; i++) {
    const d = pointSegmentDistanceSq(
      px,
      py,
      pts[i].x,
      pts[i].y,
      pts[i + 1].x,
      pts[i + 1].y
    )
    if (d < best) best = d
  }
  return Math.sqrt(best)
}

/** 从矩形中心指向 (tx,ty) 时，射线与矩形边界的交点（用于引线起点） */
function rectBorderPointToward(
  left: number,
  top: number,
  w: number,
  h: number,
  tx: number,
  ty: number
): { x: number; y: number } {
  const cx = left + w / 2
  const cy = top + h / 2
  const dx = tx - cx
  const dy = ty - cy
  const L = Math.hypot(dx, dy)
  if (L < 1e-6) return { x: cx + w / 2, y: cy }
  const ux = dx / L
  const uy = dy / L
  const halfW = w / 2
  const halfH = h / 2
  const txRay = ux !== 0 ? halfW / Math.abs(ux) : Infinity
  const tyRay = uy !== 0 ? halfH / Math.abs(uy) : Infinity
  const t = Math.min(txRay, tyRay)
  return { x: cx + ux * t, y: cy + uy * t }
}

/** pa=正极节点位置，pb=负极节点位置：长竖线在靠近 pa 侧，短竖线在靠近 pb 侧，均与连线方向垂直 */
function voltageBatteryGeometry(
  pa: { x: number; y: number },
  pb: { x: number; y: number }
) {
  const dx = pb.x - pa.x
  const dy = pb.y - pa.y
  const L = Math.hypot(dx, dy) || 1
  const ux = dx / L
  const uy = dy / L
  const px = -uy
  const py = ux
  const longHalf = 9
  const shortHalf = 5
  let tLong = 0.26 * L
  let tShort = 0.74 * L
  if (tShort - tLong < 12) {
    const mid = L / 2
    tLong = Math.max(10, mid - 8)
    tShort = Math.min(L - 10, mid + 8)
  }
  const longC = { x: pa.x + ux * tLong, y: pa.y + uy * tLong }
  const shortC = { x: pa.x + ux * tShort, y: pa.y + uy * tShort }
  const longA = { x: longC.x + px * longHalf, y: longC.y + py * longHalf }
  const longB = { x: longC.x - px * longHalf, y: longC.y - py * longHalf }
  const shortA = { x: shortC.x + px * shortHalf, y: shortC.y + py * shortHalf }
  const shortB = { x: shortC.x - px * shortHalf, y: shortC.y - py * shortHalf }
  const pad = 4
  const paJoin = { x: longC.x - ux * pad, y: longC.y - uy * pad }
  const pbJoin = { x: shortC.x + ux * pad, y: shortC.y + uy * pad }
  return { paJoin, longA, longB, shortA, shortB, pbJoin, pa, pb, m: mid(pa, pb), px, py }
}

function distToVoltageBattery(
  qx: number,
  qy: number,
  pa: { x: number; y: number },
  pb: { x: number; y: number }
): number {
  const g = voltageBatteryGeometry(pa, pb)
  const segs: Array<
    [{ x: number; y: number }, { x: number; y: number }]
  > = [
    [g.pa, g.paJoin],
    [g.longA, g.longB],
    [g.shortA, g.shortB],
    [g.pbJoin, g.pb],
  ]
  let best = Infinity
  for (const [a, b] of segs) {
    const d = pointSegmentDistanceSq(qx, qy, a.x, a.y, b.x, b.y)
    if (d < best) best = d
  }
  return Math.sqrt(best)
}

function pickBranchAt(
  branches: Branch[],
  positions: Map<number, { x: number; y: number }>,
  px: number,
  py: number,
  maxDist: number
): Branch | null {
  let best: Branch | null = null
  let bestD = maxDist
  for (const b of branches) {
    const [na, nb] = branchEndpoints(b)
    const pa = positions.get(na)
    const pb = positions.get(nb)
    if (!pa || !pb) continue
    let d: number
    if (b.kind === 'R') {
      const poly = resistorPolyline(pa.x, pa.y, pb.x, pb.y)
      d = minDistToPolyline(px, py, poly)
    } else if (b.kind === 'V' || (b.kind === 'CS' && b.output === 'V')) {
      d = distToVoltageBattery(px, py, pa, pb)
    } else {
      d = Math.sqrt(pointSegmentDistanceSq(px, py, pa.x, pa.y, pb.x, pb.y))
    }
    if (d < bestD - 1e-4) {
      bestD = d
      best = b
    }
  }
  return best
}

function probeAmpReading(
  p: CurrentProbe,
  branches: Branch[],
  solved: SolveOk | null
): string | null {
  if (!solved) return null
  const idx = branches.findIndex((b) => b.id === p.targetBranchId)
  if (idx < 0) return null
  return solved.branchCurrents[idx].toFixed(4)
}

const PROBE_POP_W = 156
const PROBE_POP_H = 42
const VOLT_POP_W = 208
const VOLT_POP_H = 40

const POPOVER_AVOID_MARGIN = 6

type PopoverRect = { x: number; y: number; w: number; h: number }

function popoverIntersectsAny(
  tlx: number,
  tly: number,
  popW: number,
  popH: number,
  rects: PopoverRect[],
  margin: number = POPOVER_AVOID_MARGIN
): boolean {
  for (const r of rects) {
    if (
      tlx - margin < r.x + r.w + margin &&
      tlx + popW + margin > r.x - margin &&
      tly - margin < r.y + r.h + margin &&
      tly + popH + margin > r.y - margin
    ) {
      return true
    }
  }
  return false
}

const CANVAS_W = 920
const CANVAS_H = 540

/**
 * 电阻 / 电源参数小字：贴在支路锚点附近（法线方向），仅轻量避让已放置的其它标注框，
 * 不使用 probePopoverTopLeft（后者会为了躲满屏采样点而把框甩到四角）。
 */
function branchParamLabelTopLeft(
  anchor: { x: number; y: number },
  ux: number,
  uy: number,
  px: number,
  py: number,
  side: number,
  w: number,
  h: number,
  avoid: PopoverRect[]
): { x: number; y: number } {
  const m = 4
  const distN = [7, 11, 15, 20, 26, 34]
  const distT = [0, -11, 11, -20, 20]
  for (const sgn of [side, -side]) {
    for (const dn of distN) {
      for (const dt of distT) {
        const cx = anchor.x + px * sgn * dn + ux * dt
        const cy = anchor.y + py * sgn * dn + uy * dt
        let tlx = cx - w / 2
        let tly = cy - h / 2
        tlx = Math.max(m, Math.min(CANVAS_W - w - m, tlx))
        tly = Math.max(m, Math.min(CANVAS_H - h - m, tly))
        if (!popoverIntersectsAny(tlx, tly, w, h, avoid)) {
          return { x: tlx, y: tly }
        }
      }
    }
  }
  const cx = anchor.x + px * side * 12
  const cy = anchor.y + py * side * 12
  return {
    x: Math.max(m, Math.min(CANVAS_W - w - m, cx - w / 2)),
    y: Math.max(m, Math.min(CANVAS_H - h - m, cy - h / 2)),
  }
}

/** 笔尖指向被测支路：从探针位置指向该支路连线上的最近点 */
function probePenAngleDeg(
  p: CurrentProbe,
  branches: Branch[],
  positions: Map<number, { x: number; y: number }>
): number {
  const b = branches.find((br) => br.id === p.targetBranchId)
  if (!b) return -35
  const [na, nb] = branchEndpoints(b)
  const pa = positions.get(na)
  const pb = positions.get(nb)
  if (!pa || !pb) return -35
  const { x: cx, y: cy } = closestPointOnSegment(
    p.x,
    p.y,
    pa.x,
    pa.y,
    pb.x,
    pb.y
  )
  let dx = cx - p.x
  let dy = cy - p.y
  let L = Math.hypot(dx, dy)
  if (L < 1.5) {
    const mx = (pa.x + pb.x) / 2
    const my = (pa.y + pb.y) / 2
    dx = mx - p.x
    dy = my - p.y
    L = Math.hypot(dx, dy) || 1
  }
  return (Math.atan2(dy, dx) * 180) / Math.PI
}

/**
 * 支路约定正电流方向为 branchEndpoints 首端→末端；返回该方向的单位切向，
 * 及支路上距探针最近点沿法向（指向探针一侧）偏移后的参考点，供紧贴笔旁画方向箭头。
 */
function branchCurrentDirectionGeometry(
  b: Branch,
  positions: Map<number, { x: number; y: number }>,
  probeX: number,
  probeY: number
): { tx: number; ty: number; ax: number; ay: number } | null {
  const [na, nb] = branchEndpoints(b)
  const pa = positions.get(na)
  const pb = positions.get(nb)
  if (!pa || !pb) return null
  const tdx = pb.x - pa.x
  const tdy = pb.y - pa.y
  const len = Math.hypot(tdx, tdy)
  if (len < 1e-6) return null
  const tx = tdx / len
  const ty = tdy / len
  const { x: cx, y: cy } = closestPointOnSegment(
    probeX,
    probeY,
    pa.x,
    pa.y,
    pb.x,
    pb.y
  )
  let nx = -ty
  let ny = tx
  if ((probeX - cx) * nx + (probeY - cy) * ny < 0) {
    nx = -nx
    ny = -ny
  }
  const off = 8
  const ax = cx + nx * off
  const ay = cy + ny * off
  return { tx, ty, ax, ay }
}

/** 在画布空白侧选弹窗左上角，尽量远离节点与支路（可附加避让点、已放置弹窗矩形） */
function probePopoverTopLeft(
  p: { x: number; y: number },
  branches: Branch[],
  positions: Map<number, { x: number; y: number }>,
  variant: number = 0,
  popW: number = PROBE_POP_W,
  popH: number = PROBE_POP_H,
  extraHazard: Array<{ x: number; y: number }> = [],
  avoidPopoverRects: PopoverRect[] = [],
  layoutMode: 'default' | 'compact' = 'default'
): { x: number; y: number } {
  const hazard: Array<{ x: number; y: number }> = [...extraHazard]
  for (const [, pt] of positions) hazard.push(pt)
  pushWireframeBranchHazards(branches, positions, hazard)
  function minDistToHazards(px: number, py: number) {
    let m = Infinity
    for (const q of hazard) {
      const d = Math.hypot(q.x - px, q.y - py)
      if (d < m) m = d
    }
    return m
  }
  function boxScore(tlx: number, tly: number) {
    const cx = tlx + popW / 2
    const cy = tly + popH / 2
    const corners: Array<[number, number]> = [
      [tlx + 4, tly + 4],
      [tlx + popW - 4, tly + 4],
      [tlx + 4, tly + popH - 4],
      [tlx + popW - 4, tly + popH - 4],
    ]
    let s = Infinity
    for (const [qx, qy] of corners) {
      const d = minDistToHazards(qx, qy)
      if (d < s) s = d
    }
    const dc = minDistToHazards(cx, cy)
    return Math.min(s, dc)
  }
  const compact = layoutMode === 'compact'
  const ringRadii = compact
    ? [10, 16, 24, 34, 46, 60, 78, 96, 120]
    : [72, 96, 120]
  const ringSamples = compact ? 32 : 20
  let best: { x: number; y: number; score: number } | null = null
  const phase = (variant * 0.71) % (Math.PI * 2)
  const overlapPenalty = 8500
  function totalScore(tlx: number, tly: number) {
    let s = boxScore(tlx, tly)
    if (popoverIntersectsAny(tlx, tly, popW, popH, avoidPopoverRects))
      s -= overlapPenalty
    return s
  }
  for (const R of ringRadii) {
    for (let k = 0; k < ringSamples; k++) {
      const ang = phase + (k / ringSamples) * Math.PI * 2
      const cx = p.x + R * Math.cos(ang)
      const cy = p.y + R * Math.sin(ang)
      let tlx = cx - popW / 2
      let tly = cy - popH / 2
      tlx = Math.max(8, Math.min(920 - popW - 8, tlx))
      tly = Math.max(8, Math.min(540 - popH - 8, tly))
      const score = totalScore(tlx, tly)
      if (!best || score > best.score) best = { x: tlx, y: tly, score }
    }
  }
  const corners = [
    { x: 12, y: 12 },
    { x: 920 - popW - 12, y: 12 },
    { x: 12, y: 540 - popH - 12 },
    { x: 920 - popW - 12, y: 540 - popH - 12 },
  ]
  for (const c of corners) {
    const score = totalScore(c.x, c.y)
    if (!best || score > best.score) best = { x: c.x, y: c.y, score }
  }
  let rx = best?.x ?? 12
  let ry = best?.y ?? 12
  const extraRadii = compact
    ? [132, 168, 210, 260, 320, 400]
    : [140, 176, 220, 280, 340]
  const escapeSamples = compact ? 56 : 48
  if (
    avoidPopoverRects.length > 0 &&
    popoverIntersectsAny(rx, ry, popW, popH, avoidPopoverRects)
  ) {
    let escape: { x: number; y: number; score: number } | null = null
    for (const R of extraRadii) {
      for (let k = 0; k < escapeSamples; k++) {
        const ang = phase + (k / escapeSamples) * Math.PI * 2
        const cx = p.x + R * Math.cos(ang)
        const cy = p.y + R * Math.sin(ang)
        let tlx = cx - popW / 2
        let tly = cy - popH / 2
        tlx = Math.max(8, Math.min(920 - popW - 8, tlx))
        tly = Math.max(8, Math.min(540 - popH - 8, tly))
        if (popoverIntersectsAny(tlx, tly, popW, popH, avoidPopoverRects))
          continue
        const sc = boxScore(tlx, tly)
        if (!escape || sc > escape.score) escape = { x: tlx, y: tly, score: sc }
      }
    }
    if (escape) {
      rx = escape.x
      ry = escape.y
    }
  }
  return { x: rx, y: ry }
}

function pickProbeAt(
  probes: CurrentProbe[],
  px: number,
  py: number,
  maxDist: number
): CurrentProbe | null {
  let best: CurrentProbe | null = null
  let bestD = maxDist
  for (const p of probes) {
    const d = Math.hypot(p.x - px, p.y - py)
    if (d < bestD - 1e-4) {
      bestD = d
      best = p
    }
  }
  return best
}

function voltageProbeReading(
  vp: VoltageProbe,
  solved: SolveOk | null,
  groundId: number | null
): string | null {
  if (!solved) return null
  const n = vp.nodeId
  if (n < 0 || n >= solved.nodeV.length) return null
  const vn = solved.nodeV[n]
  if (
    groundId !== null &&
    groundId >= 0 &&
    groundId < solved.nodeV.length
  ) {
    const rel = vn - solved.nodeV[groundId]
    return rel.toFixed(4)
  }
  return vn.toFixed(4)
}

/** 笔尖指向所测节点 */
function voltProbePenAngleDeg(
  vp: VoltageProbe,
  positions: Map<number, { x: number; y: number }>
): number {
  const np = positions.get(vp.nodeId)
  if (!np) return -35
  const dx = np.x - vp.x
  const dy = np.y - vp.y
  if (Math.hypot(dx, dy) < 1e-6) return -35
  return (Math.atan2(dy, dx) * 180) / Math.PI
}

function pickVoltageProbeAt(
  vprobes: VoltageProbe[],
  px: number,
  py: number,
  maxDist: number
): VoltageProbe | null {
  let best: VoltageProbe | null = null
  let bestD = maxDist
  for (const p of vprobes) {
    const d = Math.hypot(p.x - px, p.y - py)
    if (d < bestD - 1e-4) {
      bestD = d
      best = p
    }
  }
  return best
}

/** 射线（起点 ox,oy，单位方向 dx,dy）与线段 AB 的交；要求 t≥0 且交点在线段内 */
function intersectRayWithSegment(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): { x: number; y: number; t: number } | null {
  const sx = bx - ax
  const sy = by - ay
  const denom = dx * sy - dy * sx
  if (Math.abs(denom) < 1e-9) return null
  const qx = ax - ox
  const qy = ay - oy
  const t = (qx * sy - qy * sx) / denom
  const u = (qx * dy - qy * dx) / denom
  if (t < -1e-6) return null
  if (u < -1e-6 || u > 1 + 1e-6) return null
  return { x: ox + t * dx, y: oy + t * dy, t }
}

/** 与图中电流探针笔身粗线一致：局部 x∈[-40,-3],y=0 → 世界坐标线段 */
function currentProbePenShaftWorld(
  p: CurrentProbe,
  branches: Branch[],
  positions: Map<number, { x: number; y: number }>
): { ax: number; ay: number; bx: number; by: number } {
  const ang = (probePenAngleDeg(p, branches, positions) * Math.PI) / 180
  const c = Math.cos(ang)
  const s = Math.sin(ang)
  const toW = (lx: number, ly: number) => ({
    x: p.x + lx * c - ly * s,
    y: p.y + lx * s + ly * c,
  })
  const A = toW(-40, 0)
  const B = toW(-3, 0)
  return { ax: A.x, ay: A.y, bx: B.x, by: B.y }
}

/** 与图中电压探针笔身粗线一致 */
function voltProbePenShaftWorld(
  vp: VoltageProbe,
  positions: Map<number, { x: number; y: number }>
): { ax: number; ay: number; bx: number; by: number } {
  const ang = (voltProbePenAngleDeg(vp, positions) * Math.PI) / 180
  const c = Math.cos(ang)
  const s = Math.sin(ang)
  const toW = (lx: number, ly: number) => ({
    x: vp.x + lx * c - ly * s,
    y: vp.y + lx * s + ly * c,
  })
  const A = toW(-40, 0)
  const B = toW(-3, 0)
  return { ax: A.x, ay: A.y, bx: B.x, by: B.y }
}

/** 求解读数气泡 → 探针笔身：直线从气泡边穿出，射线与笔杆线段求交，箭头略缩进以贴合笔身 */
function solveReadLeaderToPenShaft(
  pop: { x: number; y: number },
  popW: number,
  popH: number,
  penAx: number,
  penAy: number,
  penBx: number,
  penBy: number
): { x1: number; y1: number; x2: number; y2: number } | null {
  const aimx = (penAx + penBx) / 2
  const aimy = (penAy + penBy) / 2
  const start = rectBorderPointToward(
    pop.x,
    pop.y,
    popW,
    popH,
    aimx,
    aimy
  )
  let rdx = aimx - start.x
  let rdy = aimy - start.y
  let rL = Math.hypot(rdx, rdy)
  if (rL < 1e-6) return null
  rdx /= rL
  rdy /= rL
  let hit = intersectRayWithSegment(
    start.x,
    start.y,
    rdx,
    rdy,
    penAx,
    penAy,
    penBx,
    penBy
  )
  let tip: { x: number; y: number }
  if (hit) {
    tip = { x: hit.x, y: hit.y }
  } else {
    const farx = start.x + rdx * 8000
    const fary = start.y + rdy * 8000
    tip = closestPointOnSegment(
      farx,
      fary,
      penAx,
      penAy,
      penBx,
      penBy
    )
  }
  const leg = Math.hypot(tip.x - start.x, tip.y - start.y) || 1
  const shrink = 2.8
  tip = {
    x: tip.x - ((tip.x - start.x) / leg) * shrink,
    y: tip.y - ((tip.y - start.y) / leg) * shrink,
  }
  const d = Math.hypot(tip.x - start.x, tip.y - start.y)
  if (d < 6) return null
  return { x1: start.x, y1: start.y, x2: tip.x, y2: tip.y }
}

/** 求解读数气泡 → 电流探针笔身（非支路几何） */
function solveReadLeaderForCurrentProbe(
  p: CurrentProbe,
  branches: Branch[],
  positions: Map<number, { x: number; y: number }>,
  pop: { x: number; y: number },
  popW: number,
  popH: number
): { x1: number; y1: number; x2: number; y2: number } | null {
  const shaft = currentProbePenShaftWorld(p, branches, positions)
  return solveReadLeaderToPenShaft(
    pop,
    popW,
    popH,
    shaft.ax,
    shaft.ay,
    shaft.bx,
    shaft.by
  )
}

/** 求解读数气泡 → 电压探针笔身（非节点圆） */
function solveReadLeaderForVoltageProbe(
  vp: VoltageProbe,
  positions: Map<number, { x: number; y: number }>,
  _groundId: number | null,
  pop: { x: number; y: number },
  popW: number,
  popH: number
): { x1: number; y1: number; x2: number; y2: number } | null {
  const shaft = voltProbePenShaftWorld(vp, positions)
  return solveReadLeaderToPenShaft(
    pop,
    popW,
    popH,
    shaft.ax,
    shaft.ay,
    shaft.bx,
    shaft.by
  )
}

type ProbeLabelEditTarget =
  | { kind: 'current'; id: string }
  | { kind: 'volt'; id: string }

/** 代号在裁剪后是否与「另一支」电流/电压探针重复（编辑时可排除自身） */
function isProbeLabelDuplicate(
  labelTrimmed: string,
  ignore: ProbeLabelEditTarget | null,
  currents: CurrentProbe[],
  volts: VoltageProbe[]
): boolean {
  for (const p of currents) {
    if (ignore?.kind === 'current' && ignore.id === p.id) continue
    if (p.label.trim() === labelTrimmed) return true
  }
  for (const v of volts) {
    if (ignore?.kind === 'volt' && ignore.id === v.id) continue
    if (v.label.trim() === labelTrimmed) return true
  }
  return false
}

/** 新探针默认代号：P1、P2… 全局不与已有探针重复 */
function allocateProbeLabel(
  currents: CurrentProbe[],
  volts: VoltageProbe[]
): string {
  const taken = new Set<string>()
  for (const p of currents) taken.add(p.label.trim())
  for (const v of volts) taken.add(v.label.trim())
  let n = 1
  for (;;) {
    const s = `P${n}`
    if (!taken.has(s)) return s
    n += 1
    if (n > 9999) return `P${Date.now()}`
  }
}

function variantFromString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h) % 1000
}

/** 支路参数紧凑标注（无框小字）的 foreignObject 尺寸 */
function estimateCompactBranchParamBox(lines: string[]): { w: number; h: number } {
  const fs = 9
  const lh = 11.5
  const padX = 2
  const padY = 1
  const innerW = Math.max(
    12,
    ...lines.map((l) => Math.min(120, l.length * (fs * 0.52)))
  )
  return {
    w: Math.ceil(padX * 2 + innerW),
    h: Math.ceil(padY * 2 + lines.length * lh),
  }
}

function trimCompactNum(n: number, maxDecimals: number): string {
  if (!Number.isFinite(n)) return String(n)
  let s = n.toFixed(maxDecimals).replace(/\.?0+$/, '')
  if (s === '' || s === '-0') s = '0'
  return s
}

function formatCompactOhm(ohms: number): string {
  if (!Number.isFinite(ohms) || ohms < 0) return `${ohms}Ω`
  if (ohms >= 1e6) return `${trimCompactNum(ohms / 1e6, 3)}MΩ`
  if (ohms >= 1e3) return `${trimCompactNum(ohms / 1e3, 3)}kΩ`
  if (ohms >= 1) return `${trimCompactNum(ohms, 4)}Ω`
  if (ohms >= 1e-3) return `${trimCompactNum(ohms * 1e3, 3)}mΩ`
  return `${trimCompactNum(ohms, 6)}Ω`
}

function formatCompactV(volts: number): string {
  return `${trimCompactNum(volts, 4)}V`
}

function formatCompactA(amps: number): string {
  return `${trimCompactNum(amps, 4)}A`
}

/** 接地符号附近采样点，供标注避让 */
function pushGroundGlyphHazardPoints(
  groundId: number | null,
  positions: Map<number, { x: number; y: number }>,
  out: Array<{ x: number; y: number }>
) {
  if (groundId === null) return
  const gp = positions.get(groundId)
  if (!gp) return
  const ox = gp.x - 12
  const oy = gp.y + 14
  for (let t = 0; t <= 1; t += 0.2) {
    out.push({ x: ox + t * 24, y: oy })
    out.push({ x: ox + 4 + t * 16, y: oy + 5 })
    out.push({ x: ox + 8 + t * 8, y: oy + 10 })
  }
}

function pushWireframeBranchHazards(
  branches: Branch[],
  positions: Map<number, { x: number; y: number }>,
  hazard: Array<{ x: number; y: number }>
) {
  const pushSeg = (ax: number, ay: number, bx: number, by: number) => {
    const L = Math.hypot(bx - ax, by - ay)
    const steps = Math.max(2, Math.ceil(L / 12))
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      hazard.push({
        x: ax + t * (bx - ax),
        y: ay + t * (by - ay),
      })
    }
  }
  for (const br of branches) {
    const [na, nb] = branchEndpoints(br)
    const pa = positions.get(na)
    const pb = positions.get(nb)
    if (!pa || !pb) continue
    if (br.kind === 'R') {
      const poly = resistorPolyline(pa.x, pa.y, pb.x, pb.y)
      for (let i = 0; i < poly.length - 1; i++) {
        pushSeg(poly[i].x, poly[i].y, poly[i + 1].x, poly[i + 1].y)
      }
    } else if (br.kind === 'V' || (br.kind === 'CS' && br.output === 'V')) {
      const g = voltageBatteryGeometry(pa, pb)
      pushSeg(g.pa.x, g.pa.y, g.paJoin.x, g.paJoin.y)
      pushSeg(g.longA.x, g.longA.y, g.longB.x, g.longB.y)
      pushSeg(g.shortA.x, g.shortA.y, g.shortB.x, g.shortB.y)
      pushSeg(g.pbJoin.x, g.pbJoin.y, g.pb.x, g.pb.y)
    } else if (br.kind === 'I') {
      pushSeg(pa.x, pa.y, pb.x, pb.y)
      const mx = (pa.x + pb.x) / 2
      const my = (pa.y + pb.y) / 2
      for (let k = 0; k < 12; k++) {
        const ang = (k / 12) * Math.PI * 2
        hazard.push({
          x: mx + Math.cos(ang) * 16,
          y: my + Math.sin(ang) * 16,
        })
      }
    } else {
      pushSeg(pa.x, pa.y, pb.x, pb.y)
    }
  }
}

type CtxMenu =
  | { kind: 'branch'; id: string; clientX: number; clientY: number }
  | { kind: 'probe'; id: string; clientX: number; clientY: number }
  | { kind: 'vprobe'; id: string; clientX: number; clientY: number }
  | { kind: 'node'; nodeId: number; clientX: number; clientY: number }
  | null

type TabCtxMenu = { id: string; clientX: number; clientY: number } | null

type CircuitSelection = {
  nodeIds: number[]
  currentProbeIds: string[]
  voltageProbeIds: string[]
}

const EMPTY_CIRCUIT_SELECTION: CircuitSelection = {
  nodeIds: [],
  currentProbeIds: [],
  voltageProbeIds: [],
}

function buildMarqueeSelection(
  rect: NormRect,
  branches: Branch[],
  positions: Map<number, { x: number; y: number }>,
  probes: CurrentProbe[],
  voltageProbes: VoltageProbe[]
): CircuitSelection {
  if (rect.w < 1 || rect.h < 1) {
    return {
      nodeIds: [],
      currentProbeIds: [],
      voltageProbeIds: [],
    }
  }
  const nodes = new Set<number>()
  for (const [id, pt] of positions) {
    if (pointInNormRect(pt.x, pt.y, rect)) nodes.add(id)
  }
  for (const b of branches) {
    const [na, nb] = branchEndpoints(b)
    const pa = positions.get(na)
    const pb = positions.get(nb)
    if (!pa || !pb) continue
    let hit = false
    if (b.kind === 'R') {
      const poly = resistorPolyline(pa.x, pa.y, pb.x, pb.y)
      for (let i = 0; i < poly.length - 1; i++) {
        if (
          segmentIntersectsNormRect(
            poly[i].x,
            poly[i].y,
            poly[i + 1].x,
            poly[i + 1].y,
            rect
          )
        ) {
          hit = true
          break
        }
      }
    } else if (b.kind === 'V' || (b.kind === 'CS' && b.output === 'V')) {
      const g = voltageBatteryGeometry(pa, pb)
      const segs: Array<
        [{ x: number; y: number }, { x: number; y: number }]
      > = [
        [g.pa, g.paJoin],
        [g.longA, g.longB],
        [g.shortA, g.shortB],
        [g.pbJoin, g.pb],
      ]
      for (const [a, s] of segs) {
        if (segmentIntersectsNormRect(a.x, a.y, s.x, s.y, rect)) {
          hit = true
          break
        }
      }
    } else {
      hit = segmentIntersectsNormRect(pa.x, pa.y, pb.x, pb.y, rect)
    }
    if (hit) {
      nodes.add(na)
      nodes.add(nb)
    }
  }
  const currentProbeIds: string[] = []
  for (const p of probes) {
    if (pointInNormRect(p.x, p.y, rect)) currentProbeIds.push(p.id)
  }
  const voltageProbeIds: string[] = []
  for (const v of voltageProbes) {
    if (pointInNormRect(v.x, v.y, rect)) voltageProbeIds.push(v.id)
  }
  return {
    nodeIds: [...nodes].sort((a, b) => a - b),
    currentProbeIds,
    voltageProbeIds,
  }
}

type CanvasGesture =
  | {
      kind: 'marquee'
      x0: number
      y0: number
      x1: number
      y1: number
      pointerId: number
    }
  | {
      kind: 'drag'
      pointerId: number
      lastX: number
      lastY: number
      undoPushed: boolean
    }

type CsPlaceDraft = {
  output: 'V' | 'I'
  control: 'volt' | 'curr'
  k: number
  vProbeLabelPlus: string
  vProbeLabelMinus: string
  iProbeLabel: string
}

export default function App() {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const ctxMenuRef = useRef<HTMLDivElement | null>(null)
  /** 电压源 / 电流源：单击调换前的延迟定时器 */
  const directedBranchSwapTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null)
  const [tool, setTool] = useState<Tool>('node')
  const [branches, setBranches] = useState<Branch[]>([])
  const [positions, setPositions] = useState(
    new Map<number, { x: number; y: number }>()
  )
  const [nextId, setNextId] = useState(0)
  const [groundId, setGroundId] = useState<number | null>(null)
  const [pending, setPending] = useState<number | null>(null)
  const [defaultR, setDefaultR] = useState(1000)
  const [defaultV, setDefaultV] = useState(5)
  const [defaultI, setDefaultI] = useState(0.01)
  /** 受控源：向导弹窗 */
  const [csWizardOpen, setCsWizardOpen] = useState(false)
  const [csK, setCsK] = useState('1')
  const [csOutput, setCsOutput] = useState<'V' | 'I'>('V')
  const [csControl, setCsControl] = useState<'volt' | 'curr'>('volt')
  const [csVPlus, setCsVPlus] = useState('')
  const [csVMinus, setCsVMinus] = useState('')
  const [csIProbe, setCsIProbe] = useState('')
  const [csWizardErr, setCsWizardErr] = useState<string | null>(null)
  /** 向导弹窗通过后，放置两节点时使用的参数 */
  const [csPlaceParams, setCsPlaceParams] = useState<CsPlaceDraft | null>(null)
  /** 双击受控源编辑 */
  const [editCs, setEditCs] = useState<{
    id: string
    k: string
    output: 'V' | 'I'
    control: 'volt' | 'curr'
    vPlus: string
    vMinus: string
    iProbe: string
  } | null>(null)
  const [editCsErr, setEditCsErr] = useState<string | null>(null)
  const [probes, setProbes] = useState<CurrentProbe[]>([])
  const [voltageProbes, setVoltageProbes] = useState<VoltageProbe[]>([])
  const [probeLabelEdit, setProbeLabelEdit] =
    useState<ProbeLabelEditTarget | null>(null)
  const [probeLabelDraft, setProbeLabelDraft] = useState('')
  const [probeLabelErr, setProbeLabelErr] = useState<string | null>(null)
  const [solved, setSolved] = useState<SolveOk | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pruneMsg, setPruneMsg] = useState<string | null>(null)
  const [editBranchId, setEditBranchId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [modalErr, setModalErr] = useState<string | null>(null)
  const [circuitSelection, setCircuitSelection] = useState<CircuitSelection>(
    () => ({
      nodeIds: [],
      currentProbeIds: [],
      voltageProbeIds: [],
    })
  )
  const [marqueeRect, setMarqueeRect] = useState<NormRect | null>(null)
  const circuitSelectionRef = useRef<CircuitSelection>(circuitSelection)
  circuitSelectionRef.current = circuitSelection
  const canvasGestureRef = useRef<CanvasGesture | null>(null)
  const ignoreNextSvgClickRef = useRef(false)
  const [ctxMenu, setCtxMenu] = useState<CtxMenu>(null)
  const [tabCtxMenu, setTabCtxMenu] = useState<TabCtxMenu>(null)
  const tabBarCtxMenuRef = useRef<HTMLDivElement | null>(null)
  const [tabRename, setTabRename] = useState<{ id: string } | null>(null)
  const [tabRenameDraft, setTabRenameDraft] = useState('')
  const [tabRenameErr, setTabRenameErr] = useState<string | null>(null)
  const [tabNotice, setTabNotice] = useState<string | null>(null)
  const tabListRef = useRef<HTMLDivElement | null>(null)
  const dragTabIdRef = useRef<string | null>(null)
  const tabReorderSuppressClickUntilRef = useRef(0)
  const tabNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tabFlipBeforeRef = useRef<Map<string, DOMRect> | null>(null)
  const tabDragRafRef = useRef<number | null>(null)
  const tabFlipClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  const pendingTabDragRef = useRef<{
    tabId: string
    clientX: number
  } | null>(null)

  const initBoardIdRef = useRef<string | null>(null)
  if (initBoardIdRef.current === null) {
    initBoardIdRef.current = newId('Board')
  }
  const [tabsData, setTabsData] = useState<TabPersist[]>(() => [
    {
      id: initBoardIdRef.current!,
      name: '画板 1',
      circuit: emptyCircuitSnapshot(),
      solved: null,
      error: null,
      pruneMsg: null,
      undoStack: [],
    },
  ])
  const [activeTabId, setActiveTabId] = useState(() => initBoardIdRef.current!)
  const activeTabIdRef = useRef(activeTabId)
  activeTabIdRef.current = activeTabId
  const tabsDataRef = useRef(tabsData)
  tabsDataRef.current = tabsData

  const [toolbarToolOrder, setToolbarToolOrder] = useState<
    DraggableToolbarTool[]
  >(() => [...DEFAULT_TOOLBAR_TOOL_ORDER])
  const toolbarToolOrderRef = useRef(toolbarToolOrder)
  toolbarToolOrderRef.current = toolbarToolOrder
  const toolbarListRef = useRef<HTMLDivElement | null>(null)
  const toolbarDragIdRef = useRef<DraggableToolbarTool | null>(null)
  const pendingToolbarDragRef = useRef<{
    toolId: DraggableToolbarTool
    clientX: number
  } | null>(null)
  const toolbarDragRafRef = useRef<number | null>(null)
  const toolbarFlipBeforeRef = useRef<Map<string, DOMRect> | null>(null)
  const toolbarFlipClearTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null)
  const toolbarReorderSuppressClickUntilRef = useRef(0)

  const measureBoardTabRects = useCallback((): Map<string, DOMRect> => {
    const map = new Map<string, DOMRect>()
    const root = tabListRef.current
    if (!root) return map
    Array.from(root.querySelectorAll('[data-tab-id]')).forEach((node) => {
      const el = node as HTMLElement
      const id = el.dataset.tabId
      if (id) map.set(id, el.getBoundingClientRect())
    })
    return map
  }, [])

  const flushTabDragOver = useCallback(() => {
    tabDragRafRef.current = null
    const p = pendingTabDragRef.current
    pendingTabDragRef.current = null
    if (!p) return
    const dragId = dragTabIdRef.current
    if (!dragId) return
    const root = tabListRef.current
    if (!root) return
    const el = Array.from(root.querySelectorAll('[data-tab-id]')).find(
      (node) => (node as HTMLElement).dataset.tabId === p.tabId
    ) as HTMLElement | undefined
    if (!el) return
    const rect = el.getBoundingClientRect()
    const placeAfter = p.clientX > rect.left + rect.width / 2
    const list = tabsDataRef.current
    const next = reorderTabsDuringDrag(list, dragId, p.tabId, placeAfter)
    if (!next) return
    tabFlipBeforeRef.current = measureBoardTabRects()
    setTabsData(next)
  }, [measureBoardTabRects])

  const measureToolbarToolRects = useCallback((): Map<string, DOMRect> => {
    const map = new Map<string, DOMRect>()
    const root = toolbarListRef.current
    if (!root) return map
    Array.from(root.querySelectorAll('[data-toolbar-tool]')).forEach(
      (node) => {
        const el = node as HTMLElement
        const id = el.dataset.toolbarTool
        if (id) map.set(id, el.getBoundingClientRect())
      }
    )
    return map
  }, [])

  const flushToolbarDragOver = useCallback(() => {
    toolbarDragRafRef.current = null
    const p = pendingToolbarDragRef.current
    pendingToolbarDragRef.current = null
    if (!p) return
    const dragId = toolbarDragIdRef.current
    if (!dragId) return
    const root = toolbarListRef.current
    if (!root) return
    const el = Array.from(root.querySelectorAll('[data-toolbar-tool]')).find(
      (node) => (node as HTMLElement).dataset.toolbarTool === p.toolId
    ) as HTMLElement | undefined
    if (!el) return
    const rect = el.getBoundingClientRect()
    const placeAfter = p.clientX > rect.left + rect.width / 2
    const list = toolbarToolOrderRef.current
    const next = reorderDraggableIdsDuringDrag<DraggableToolbarTool>(
      list,
      dragId,
      p.toolId,
      placeAfter
    )
    if (!next) return
    toolbarFlipBeforeRef.current = measureToolbarToolRects()
    setToolbarToolOrder(next)
  }, [measureToolbarToolRects])

  useLayoutEffect(() => {
    const before = tabFlipBeforeRef.current
    if (!before || before.size === 0) return
    tabFlipBeforeRef.current = null
    if (tabFlipClearTimerRef.current) {
      clearTimeout(tabFlipClearTimerRef.current)
      tabFlipClearTimerRef.current = null
    }
    const root = tabListRef.current
    if (!root) return
    const nodes = Array.from(
      root.querySelectorAll('[data-tab-id]')
    ) as HTMLElement[]
    let animated = 0
    for (const node of nodes) {
      const id = node.dataset.tabId
      if (!id) continue
      const prevR = before.get(id)
      if (!prevR) continue
      const nextR = node.getBoundingClientRect()
      const dx = prevR.left - nextR.left
      const dy = prevR.top - nextR.top
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
      animated++
      node.style.transform = `translate3d(${dx}px, ${dy}px, 0)`
      node.style.transition = 'none'
    }
    if (animated === 0) return
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const node of nodes) {
          if (!node.style.transform) continue
          node.style.transition =
            'transform 0.2s cubic-bezier(0.25, 0.8, 0.25, 1)'
          node.style.transform = 'translate3d(0,0,0)'
        }
        tabFlipClearTimerRef.current = window.setTimeout(() => {
          tabFlipClearTimerRef.current = null
          for (const node of nodes) {
            node.style.transition = ''
            node.style.transform = ''
          }
        }, 240)
      })
    })
  }, [tabsData])

  useLayoutEffect(() => {
    const before = toolbarFlipBeforeRef.current
    if (!before || before.size === 0) return
    toolbarFlipBeforeRef.current = null
    if (toolbarFlipClearTimerRef.current) {
      clearTimeout(toolbarFlipClearTimerRef.current)
      toolbarFlipClearTimerRef.current = null
    }
    const root = toolbarListRef.current
    if (!root) return
    const nodes = Array.from(
      root.querySelectorAll('[data-toolbar-tool]')
    ) as HTMLElement[]
    let animated = 0
    for (const node of nodes) {
      const id = node.dataset.toolbarTool
      if (!id) continue
      const prevR = before.get(id)
      if (!prevR) continue
      const nextR = node.getBoundingClientRect()
      const dx = prevR.left - nextR.left
      const dy = prevR.top - nextR.top
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
      animated++
      node.style.transform = `translate3d(${dx}px, ${dy}px, 0)`
      node.style.transition = 'none'
    }
    if (animated === 0) return
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const node of nodes) {
          if (!node.style.transform) continue
          node.style.transition =
            'transform 0.2s cubic-bezier(0.25, 0.8, 0.25, 1)'
          node.style.transform = 'translate3d(0,0,0)'
        }
        toolbarFlipClearTimerRef.current = window.setTimeout(() => {
          toolbarFlipClearTimerRef.current = null
          for (const node of nodes) {
            node.style.transition = ''
            node.style.transform = ''
          }
        }, 240)
      })
    })
  }, [toolbarToolOrder])

  const undoStackRef = useRef<CircuitSnapshot[]>([])
  const [undoAvailable, setUndoAvailable] = useState(false)
  const latestCircuitRef = useRef({
    branches: [] as Branch[],
    positions: new Map<number, { x: number; y: number }>(),
    groundId: null as number | null,
    nextId: 0,
    probes: [] as CurrentProbe[],
    voltageProbes: [] as VoltageProbe[],
  })
  const latestBoardUiRef = useRef({
    solved: null as SolveOk | null,
    error: null as string | null,
    pruneMsg: null as string | null,
  })
  latestCircuitRef.current = {
    branches,
    positions,
    groundId,
    nextId,
    probes,
    voltageProbes,
  }
  latestBoardUiRef.current = { solved, error, pruneMsg }

  const editingBranch = useMemo(
    () => branches.find((b) => b.id === editBranchId) ?? null,
    [branches, editBranchId]
  )

  const selectedNodeSet = useMemo(
    () => new Set(circuitSelection.nodeIds),
    [circuitSelection.nodeIds]
  )
  const selectedCurrentProbeSet = useMemo(
    () => new Set(circuitSelection.currentProbeIds),
    [circuitSelection.currentProbeIds]
  )
  const selectedVoltageProbeSet = useMemo(
    () => new Set(circuitSelection.voltageProbeIds),
    [circuitSelection.voltageProbeIds]
  )

  const activateTool = useCallback((t: Tool) => {
    setTool(t)
    setPending(null)
    setEditBranchId(null)
    setModalErr(null)
    setEditCs(null)
    setEditCsErr(null)
    if (t === 'cSource') {
      setCsWizardOpen(true)
      setCsWizardErr(null)
      setCsPlaceParams(null)
      setCsK('1')
      setCsOutput('V')
      setCsControl('volt')
      setCsVPlus('')
      setCsVMinus('')
      setCsIProbe('')
    } else {
      setCsWizardOpen(false)
      setCsPlaceParams(null)
    }
  }, [])

  useEffect(() => {
    if (tool !== 'select') {
      canvasGestureRef.current = null
      setMarqueeRect(null)
      setCircuitSelection(EMPTY_CIRCUIT_SELECTION)
    }
  }, [tool])

  useEffect(() => {
    return () => {
      if (directedBranchSwapTimerRef.current !== null) {
        clearTimeout(directedBranchSwapTimerRef.current)
        directedBranchSwapTimerRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!editBranchId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setEditBranchId(null)
        setModalErr(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editBranchId])

  useEffect(() => {
    if (!editCs) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setEditCs(null)
        setEditCsErr(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editCs])

  useEffect(() => {
    if (!ctxMenu) return
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [ctxMenu])

  useEffect(() => {
    if (!ctxMenu) return
    const closeIfOutside = (ev: MouseEvent) => {
      if (ev.button !== 0) return
      const el = ctxMenuRef.current
      if (!el) return
      const t = ev.target as Node
      if (!el.contains(t)) setCtxMenu(null)
    }
    document.addEventListener('click', closeIfOutside, true)
    return () => document.removeEventListener('click', closeIfOutside, true)
  }, [ctxMenu])

  useEffect(() => {
    if (!tabCtxMenu) return
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTabCtxMenu(null)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [tabCtxMenu])

  useEffect(() => {
    if (!tabCtxMenu) return
    const closeIfOutside = (ev: MouseEvent) => {
      if (ev.button !== 0) return
      const el = tabBarCtxMenuRef.current
      if (!el) return
      const t = ev.target as Node
      if (!el.contains(t)) setTabCtxMenu(null)
    }
    document.addEventListener('click', closeIfOutside, true)
    return () => document.removeEventListener('click', closeIfOutside, true)
  }, [tabCtxMenu])

  useEffect(() => {
    return () => {
      if (tabNoticeTimerRef.current) clearTimeout(tabNoticeTimerRef.current)
      if (tabFlipClearTimerRef.current)
        clearTimeout(tabFlipClearTimerRef.current)
      if (toolbarFlipClearTimerRef.current)
        clearTimeout(toolbarFlipClearTimerRef.current)
    }
  }, [])

  const toolHint = useMemo(() => {
    switch (tool) {
      case 'select':
        return '编辑：在空白处按住左键拖出虚线框可多选节点与支路；选中后拖动可整体平移；左键单击空白取消选择。电阻单击打开参数；电压源、电流源、受控源单击调换参考方向（约 0.26s），双击改参数。导线请用右键删除。'
      case 'node':
        return '节点：在空白处点击放置电气节点。'
      case 'R':
        return pending === null
          ? '电阻：先点击一个节点，再点击另一节点完成连接。'
          : '电阻：请选择第二个节点。'
      case 'V':
        return pending === null
          ? '电压源：先点击正极（+）所在节点，再点击负极（−）。'
          : '电压源：请选择负极（−）节点。'
      case 'I':
        return pending === null
          ? '电流源：先点击「电流流出」端节点，再点击「电流流入」端节点（电流经电源内部从前者流向后者）。'
          : '电流源：请选择电流流入端节点。'
      case 'probe':
        return '电流探针：绿色笔尖指向被测支路；点击支路附近放置。放置时自动生成代号（如 P1），可右键改名；与电压探针代号不可重复。求解后另有读数弹窗。'
      case 'voltProbe':
        return '电压探针：黄色笔尖指向所测节点；点击节点圆点附近放置。放置时自动生成代号（如 P2），可右键改名；与电流探针代号不可重复。求解后另有读数弹窗。'
      case 'wire':
        return pending === null
          ? '导线：依次点击两个节点，在两节点间画导线（不合并节点；电学上等效短接）。'
          : '导线：请选择第二个节点。'
      case 'gnd':
        return '接地：点击一个节点作为参考地（0 V）。'
      case 'cSource':
        return csPlaceParams === null
          ? '受控源：在弹窗中填写比例系数 k、输出类型（电压/电流）、控制类型（电压控制/电流控制）及探针代号后，先点正极/流出端节点，再点负极/流入端节点。'
          : csPlaceParams.output === 'V'
            ? '受控源（电压输出）：请点击正极（+）节点，再点负极（−）。'
            : '受控源（电流输出）：请先点电流流出端节点，再点流入端节点。'
      default:
        return '选择工具后按提示操作；完成后点击「求解」。电阻、电压源、电流源、受控源的参数以元件旁小号显示；支路电流在求解后以第二行小号显示。电流/电压探针代号以小字贴在笔旁。电压源、电流源、受控源均为单击调换参考方向，双击改参数。右键节点、支路、电流/电压探针可删除（电压源、电流源、受控源右键还可调换；电流/电压探针可命名，且任意两探针代号不可相同）。工具栏「撤回」可撤销上一步电路改动。'
    }
  }, [tool, pending, csPlaceParams])

  /** 支路/探针代号/求解读数等：统一近旁布局，互不遮挡且避让电路几何（不绘制节点编号） */
  const circuitOverlayLayout = useMemo(() => {
    type BranchTag = {
      x: number
      y: number
      w: number
      h: number
      line1: string
      line2: string | null
      kind: 'R' | 'V' | 'I' | 'CS'
    }
    type ProbeTag = {
      x: number
      y: number
      w: number
      h: number
      label: string
    }
    const branchTags = new Map<string, BranchTag>()
    const currentProbeTags = new Map<string, ProbeTag>()
    const voltProbeTags = new Map<string, ProbeTag>()
    const solveCurrentById = new Map<string, { x: number; y: number }>()
    const solveVoltById = new Map<string, { x: number; y: number }>()

    const placed: PopoverRect[] = []
    const groundPts: Array<{ x: number; y: number }> = []
    pushGroundGlyphHazardPoints(groundId, positions, groundPts)

    function probePenHazards(
      pr: CurrentProbe,
      out: Array<{ x: number; y: number }>
    ) {
      const ang = (probePenAngleDeg(pr, branches, positions) * Math.PI) / 180
      const ux = Math.cos(ang)
      const uy = Math.sin(ang)
      for (let d = 0; d <= 44; d += 7) {
        out.push({ x: pr.x + ux * d, y: pr.y + uy * d })
      }
    }
    function voltPenHazards(
      vp: VoltageProbe,
      out: Array<{ x: number; y: number }>
    ) {
      const ang = (voltProbePenAngleDeg(vp, positions) * Math.PI) / 180
      const ux = Math.cos(ang)
      const uy = Math.sin(ang)
      for (let d = 0; d <= 44; d += 7) {
        out.push({ x: vp.x + ux * d, y: vp.y + uy * d })
      }
    }

    /* 不显示节点编号标签，避免画布杂乱；接地仍由节点旁符号表示 */

    branches.forEach((b, bi) => {
      if (b.kind === 'W') return
      const [na, nb] = branchEndpoints(b)
      const pa = positions.get(na)
      const pb = positions.get(nb)
      if (!pa || !pb) return
      const cur =
        solved !== null &&
        bi >= 0 &&
        bi < solved.branchCurrents.length
          ? solved.branchCurrents[bi]
          : undefined
      let line1: string
      let line2: string | null = null
      let anchor: { x: number; y: number }
      let kind: 'R' | 'V' | 'I' | 'CS'
      const dx = pb.x - pa.x
      const dy = pb.y - pa.y
      const len = Math.hypot(dx, dy) || 1
      const px = -dy / len
      const py = dx / len
      const ux = dx / len
      const uy = dy / len
      const side = bi % 2 === 0 ? 1 : -1
      if (b.kind === 'R') {
        kind = 'R'
        line1 = formatCompactOhm(b.ohms)
        if (cur !== undefined) line2 = formatCompactA(cur)
        anchor = mid(pa, pb)
      } else if (b.kind === 'V') {
        kind = 'V'
        line1 = formatCompactV(b.volts)
        if (cur !== undefined) line2 = formatCompactA(cur)
        anchor = voltageBatteryGeometry(pa, pb).m
      } else if (b.kind === 'CS') {
        kind = 'CS'
        const ctrl =
          b.control === 'volt'
            ? `k×(${b.vProbeLabelPlus.trim()}−${b.vProbeLabelMinus.trim()})`
            : `k×I(${b.iProbeLabel.trim()})`
        line1 =
          b.output === 'V' ? `${ctrl}→U` : `${ctrl}→Is`
        if (cur !== undefined) line2 = formatCompactA(cur)
        anchor =
          b.output === 'V'
            ? voltageBatteryGeometry(pa, pb).m
            : mid(pa, pb)
      } else if (b.kind === 'I') {
        kind = 'I'
        line1 = formatCompactA(b.amps)
        if (cur !== undefined) {
          const s2 = formatCompactA(cur)
          line2 = s2 !== line1 ? s2 : null
        }
        anchor = mid(pa, pb)
      } else {
        return
      }
      const lines = line2 ? [line1, line2] : [line1]
      const hb = estimateCompactBranchParamBox(lines)
      const pos = branchParamLabelTopLeft(
        anchor,
        ux,
        uy,
        px,
        py,
        side,
        hb.w,
        hb.h,
        placed
      )
      branchTags.set(b.id, {
        x: pos.x,
        y: pos.y,
        w: hb.w,
        h: hb.h,
        line1,
        line2,
        kind,
      })
      placed.push({ x: pos.x, y: pos.y, w: hb.w, h: hb.h })
    })

    for (const p of probes) {
      const lab = (p.label || '?').trim() || '?'
      const hb = estimateCompactBranchParamBox([lab])
      const ang = (probePenAngleDeg(p, branches, positions) * Math.PI) / 180
      const ux = Math.cos(ang)
      const uy = Math.sin(ang)
      const px = -uy
      const py = ux
      const side = variantFromString(p.id) % 2 === 0 ? 1 : -1
      const pos = branchParamLabelTopLeft(
        { x: p.x, y: p.y },
        ux,
        uy,
        px,
        py,
        side,
        hb.w,
        hb.h,
        placed
      )
      currentProbeTags.set(p.id, {
        x: pos.x,
        y: pos.y,
        w: hb.w,
        h: hb.h,
        label: p.label,
      })
      placed.push({ x: pos.x, y: pos.y, w: hb.w, h: hb.h })
    }

    for (const vp of voltageProbes) {
      const lab = (vp.label || '?').trim() || '?'
      const hb = estimateCompactBranchParamBox([lab])
      const ang = (voltProbePenAngleDeg(vp, positions) * Math.PI) / 180
      const ux = Math.cos(ang)
      const uy = Math.sin(ang)
      const px = -uy
      const py = ux
      const side = variantFromString(vp.id) % 2 === 0 ? 1 : -1
      const pos = branchParamLabelTopLeft(
        { x: vp.x, y: vp.y },
        ux,
        uy,
        px,
        py,
        side,
        hb.w,
        hb.h,
        placed
      )
      voltProbeTags.set(vp.id, {
        x: pos.x,
        y: pos.y,
        w: hb.w,
        h: hb.h,
        label: vp.label,
      })
      placed.push({ x: pos.x, y: pos.y, w: hb.w, h: hb.h })
    }

    if (solved) {
      let pi = 0
      for (const p of probes) {
        const reading = probeAmpReading(p, branches, solved)
        if (reading === null) continue
        const extraH: Array<{ x: number; y: number }> = [
          ...groundPts,
          ...voltageProbes.map((v) => ({ x: v.x, y: v.y })),
        ]
        for (const op of probes) {
          if (op.id !== p.id) probePenHazards(op, extraH)
        }
        for (const vp of voltageProbes) voltPenHazards(vp, extraH)
        const pos = probePopoverTopLeft(
          p,
          branches,
          positions,
          pi,
          PROBE_POP_W,
          PROBE_POP_H,
          extraH,
          placed,
          'default'
        )
        solveCurrentById.set(p.id, pos)
        placed.push({ x: pos.x, y: pos.y, w: PROBE_POP_W, h: PROBE_POP_H })
        pi += 1
      }
      let vi = 0
      for (const vp of voltageProbes) {
        const reading = voltageProbeReading(vp, solved, groundId)
        if (reading === null) continue
        const extraH: Array<{ x: number; y: number }> = [...groundPts]
        for (const op of probes) probePenHazards(op, extraH)
        for (const ov of voltageProbes) {
          if (ov.id !== vp.id) voltPenHazards(ov, extraH)
        }
        const pos = probePopoverTopLeft(
          vp,
          branches,
          positions,
          vi + 33,
          VOLT_POP_W,
          VOLT_POP_H,
          extraH,
          placed,
          'default'
        )
        solveVoltById.set(vp.id, pos)
        placed.push({ x: pos.x, y: pos.y, w: VOLT_POP_W, h: VOLT_POP_H })
        vi += 1
      }
    }

    return {
      branchTags,
      currentProbeTags,
      voltProbeTags,
      solveCurrentById,
      solveVoltById,
    }
  }, [branches, positions, groundId, probes, voltageProbes, solved])

  const runCompact = useCallback(
    (b: Branch[], p: Map<number, { x: number; y: number }>, g: number | null) => {
      const out = applyCompact(b, p, g)
      setBranches(out.branches)
      setPositions(out.positions)
      setGroundId(out.groundId)
      setNextId(out.nextId)
      setVoltageProbes((prev) =>
        prev
          .map((vp) => {
            const nn = out.idMap.get(vp.nodeId)
            if (nn === undefined) return null
            return { ...vp, nodeId: nn }
          })
          .filter((x): x is VoltageProbe => x !== null)
      )
      setSolved(null)
      setError(null)
    },
    []
  )

  const closeEditModal = useCallback(() => {
    setEditBranchId(null)
    setModalErr(null)
    setEditCs(null)
    setEditCsErr(null)
  }, [])

  const closeProbeLabelModal = useCallback(() => {
    setProbeLabelEdit(null)
    setProbeLabelDraft('')
    setProbeLabelErr(null)
    setCsPlaceParams(null)
    setCsWizardOpen(false)
    setCsWizardErr(null)
    setEditCs(null)
    setEditCsErr(null)
  }, [])

  const applyProbeLabel = () => {
    if (!probeLabelEdit) return
    const t = probeLabelDraft.trim()
    if (!t) {
      setProbeLabelErr('请输入非空代号。')
      return
    }
    if (isProbeLabelDuplicate(t, probeLabelEdit, probes, voltageProbes)) {
      setProbeLabelErr('代号与另一电流或电压探针重复，请更换。')
      return
    }
    pushCircuitUndo()
    if (probeLabelEdit.kind === 'current') {
      setProbes((prev) =>
        prev.map((p) =>
          p.id === probeLabelEdit.id ? { ...p, label: t } : p
        )
      )
    } else {
      setVoltageProbes((prev) =>
        prev.map((v) =>
          v.id === probeLabelEdit.id ? { ...v, label: t } : v
        )
      )
    }
    setSolved(null)
    setError(null)
    closeProbeLabelModal()
  }

  useEffect(() => {
    if (!probeLabelEdit) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeProbeLabelModal()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [probeLabelEdit, closeProbeLabelModal])

  const pushCircuitUndo = useCallback(() => {
    const {
      branches: b,
      positions: p,
      groundId: g,
      nextId: n,
      probes: pr,
      voltageProbes: vr,
    } = latestCircuitRef.current
    undoStackRef.current.push(cloneCircuitSnapshot(b, p, g, n, pr, vr))
    if (undoStackRef.current.length > MAX_CIRCUIT_UNDO) {
      undoStackRef.current.shift()
    }
    setUndoAvailable(true)
  }, [])

  const applySelectionDragDelta = useCallback((dx: number, dy: number) => {
    const sel = circuitSelectionRef.current
    if (
      sel.nodeIds.length === 0 &&
      sel.currentProbeIds.length === 0 &&
      sel.voltageProbeIds.length === 0
    ) {
      return
    }
    const clamp = (v: number, lo: number, hi: number) =>
      Math.max(lo, Math.min(hi, v))
    setPositions((prev) => {
      const next = new Map(prev)
      for (const id of sel.nodeIds) {
        const p = next.get(id)
        if (!p) continue
        next.set(id, {
          x: clamp(p.x + dx, 6, 914),
          y: clamp(p.y + dy, 6, 534),
        })
      }
      return next
    })
    setProbes((prev) =>
      prev.map((p) =>
        sel.currentProbeIds.includes(p.id)
          ? {
              ...p,
              x: clamp(p.x + dx, 6, 914),
              y: clamp(p.y + dy, 6, 534),
            }
          : p
      )
    )
    setVoltageProbes((prev) =>
      prev.map((v) =>
        sel.voltageProbeIds.includes(v.id)
          ? {
              ...v,
              x: clamp(v.x + dx, 6, 914),
              y: clamp(v.y + dy, 6, 534),
            }
          : v
      )
    )
    setSolved(null)
    setPruneMsg(null)
    setError(null)
  }, [])

  const onSvgPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (e.button !== 0 || tool !== 'select') return
      const svg = svgRef.current
      if (!svg) return
      const { x, y } = svgPoint(svg, e.clientX, e.clientY)
      const hitN = nearestNode(positions, x, y, 14)
      if (hitN !== null) {
        e.preventDefault()
        try {
          ;(e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId)
        } catch {
          /* ignore */
        }
        setCircuitSelection((prev) => {
          if (
            prev.currentProbeIds.length === 0 &&
            prev.voltageProbeIds.length === 0 &&
            prev.nodeIds.includes(hitN)
          ) {
            return prev
          }
          return {
            nodeIds: [hitN],
            currentProbeIds: [],
            voltageProbeIds: [],
          }
        })
        canvasGestureRef.current = {
          kind: 'drag',
          pointerId: e.pointerId,
          lastX: x,
          lastY: y,
          undoPushed: false,
        }
        return
      }
      const pr = pickProbeAt(probes, x, y, 22)
      if (pr) {
        e.preventDefault()
        try {
          ;(e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId)
        } catch {
          /* ignore */
        }
        setCircuitSelection({
          nodeIds: [],
          currentProbeIds: [pr.id],
          voltageProbeIds: [],
        })
        canvasGestureRef.current = {
          kind: 'drag',
          pointerId: e.pointerId,
          lastX: x,
          lastY: y,
          undoPushed: false,
        }
        return
      }
      const vpr = pickVoltageProbeAt(voltageProbes, x, y, 22)
      if (vpr) {
        e.preventDefault()
        try {
          ;(e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId)
        } catch {
          /* ignore */
        }
        setCircuitSelection({
          nodeIds: [],
          currentProbeIds: [],
          voltageProbeIds: [vpr.id],
        })
        canvasGestureRef.current = {
          kind: 'drag',
          pointerId: e.pointerId,
          lastX: x,
          lastY: y,
          undoPushed: false,
        }
        return
      }
      const br = pickBranchAt(branches, positions, x, y, 14)
      if (br) {
        e.preventDefault()
        try {
          ;(e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId)
        } catch {
          /* ignore */
        }
        const [na, nb] = branchEndpoints(br)
        const nodeIds =
          na === nb ? [na] : na < nb ? [na, nb] : [nb, na]
        setCircuitSelection({
          nodeIds,
          currentProbeIds: [],
          voltageProbeIds: [],
        })
        canvasGestureRef.current = {
          kind: 'drag',
          pointerId: e.pointerId,
          lastX: x,
          lastY: y,
          undoPushed: false,
        }
        return
      }
      e.preventDefault()
      try {
        ;(e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      canvasGestureRef.current = {
        kind: 'marquee',
        x0: x,
        y0: y,
        x1: x,
        y1: y,
        pointerId: e.pointerId,
      }
      setMarqueeRect(normalizeSvgRect(x, y, x, y))
    },
    [tool, positions, branches, probes, voltageProbes]
  )

  const onSvgPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const g = canvasGestureRef.current
      if (!g || g.pointerId !== e.pointerId) return
      const svg = svgRef.current
      if (!svg) return
      const { x, y } = svgPoint(svg, e.clientX, e.clientY)
      if (g.kind === 'marquee') {
        g.x1 = x
        g.y1 = y
        setMarqueeRect(normalizeSvgRect(g.x0, g.y0, g.x1, g.y1))
        return
      }
      const dx = x - g.lastX
      const dy = y - g.lastY
      g.lastX = x
      g.lastY = y
      if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return
      if (!g.undoPushed) {
        pushCircuitUndo()
        g.undoPushed = true
      }
      applySelectionDragDelta(dx, dy)
    },
    [pushCircuitUndo, applySelectionDragDelta]
  )

  const endCanvasPointer = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const g = canvasGestureRef.current
      if (!g || g.pointerId !== e.pointerId) return
      canvasGestureRef.current = null
      const el = e.currentTarget as SVGSVGElement
      try {
        if (el.hasPointerCapture(e.pointerId)) {
          el.releasePointerCapture(e.pointerId)
        }
      } catch {
        /* ignore */
      }
      if (g.kind === 'marquee') {
        const r = normalizeSvgRect(g.x0, g.y0, g.x1, g.y1)
        setMarqueeRect(null)
        ignoreNextSvgClickRef.current = true
        if (r.w < 4 && r.h < 4) {
          setCircuitSelection(EMPTY_CIRCUIT_SELECTION)
          closeEditModal()
        } else {
          setCircuitSelection(
            buildMarqueeSelection(
              r,
              branches,
              positions,
              probes,
              voltageProbes
            )
          )
        }
        return
      }
      if (g.undoPushed) {
        ignoreNextSvgClickRef.current = true
      }
    },
    [branches, positions, probes, voltageProbes, closeEditModal]
  )

  const undoCircuit = useCallback(() => {
    const snap = undoStackRef.current.pop()
    if (!snap) {
      setUndoAvailable(false)
      return
    }
    setUndoAvailable(undoStackRef.current.length > 0)
    setBranches(structuredClone(snap.branches) as Branch[])
    setPositions(new Map(snap.positions))
    setGroundId(snap.groundId)
    setNextId(snap.nextId)
    setProbes(snap.probes.map((p) => ({ ...p })))
    setVoltageProbes(snap.voltageProbes.map((v) => ({ ...v })))
    setSolved(null)
    setError(null)
    setPruneMsg(null)
    setPending(null)
    setCtxMenu(null)
    closeEditModal()
    closeProbeLabelModal()
    setCircuitSelection(EMPTY_CIRCUIT_SELECTION)
    if (directedBranchSwapTimerRef.current !== null) {
      clearTimeout(directedBranchSwapTimerRef.current)
      directedBranchSwapTimerRef.current = null
    }
  }, [closeEditModal, closeProbeLabelModal])

  const applyTabPersistSync = useCallback((t: TabPersist) => {
    const snap = t.circuit
    setBranches(structuredClone(snap.branches) as Branch[])
    setPositions(new Map(snap.positions))
    setGroundId(snap.groundId)
    setNextId(snap.nextId)
    setProbes(snap.probes.map((p) => ({ ...p })))
    setVoltageProbes(snap.voltageProbes.map((v) => ({ ...v })))
    setSolved(t.solved ? (structuredClone(t.solved) as SolveOk) : null)
    setError(t.error)
    setPruneMsg(t.pruneMsg)
    undoStackRef.current = cloneUndoStack(t.undoStack)
    setUndoAvailable(undoStackRef.current.length > 0)
    setPending(null)
    setEditBranchId(null)
    setModalErr(null)
    setCtxMenu(null)
    setTabCtxMenu(null)
    closeProbeLabelModal()
    closeEditModal()
    setCircuitSelection(EMPTY_CIRCUIT_SELECTION)
    if (directedBranchSwapTimerRef.current !== null) {
      clearTimeout(directedBranchSwapTimerRef.current)
      directedBranchSwapTimerRef.current = null
    }
  }, [closeEditModal, closeProbeLabelModal])

  const switchToTab = useCallback(
    (id: string) => {
      if (id === activeTabIdRef.current) return
      const curId = activeTabIdRef.current
      const c = latestCircuitRef.current
      const ui = latestBoardUiRef.current
      const curCirc = cloneCircuitSnapshot(
        c.branches,
        c.positions,
        c.groundId,
        c.nextId,
        c.probes,
        c.voltageProbes
      )
      const merged = buildFlushedTabsList(
        tabsDataRef.current,
        curId,
        curCirc,
        ui.solved,
        ui.error,
        ui.pruneMsg,
        undoStackRef.current
      )
      const target = merged.find((x) => x.id === id)
      if (!target) return
      applyTabPersistSync(target)
      setTabsData(merged)
      setActiveTabId(id)
    },
    [applyTabPersistSync]
  )

  const addBoardTab = useCallback(() => {
    const curId = activeTabIdRef.current
    const c = latestCircuitRef.current
    const ui = latestBoardUiRef.current
    const curCirc = cloneCircuitSnapshot(
      c.branches,
      c.positions,
      c.groundId,
      c.nextId,
      c.probes,
      c.voltageProbes
    )
    const merged = buildFlushedTabsList(
      tabsDataRef.current,
      curId,
      curCirc,
      ui.solved,
      ui.error,
      ui.pruneMsg,
      undoStackRef.current
    )
    const nid = newId('Board')
    const next: TabPersist = {
      id: nid,
      name: `画板 ${merged.length + 1}`,
      circuit: emptyCircuitSnapshot(),
      solved: null,
      error: null,
      pruneMsg: null,
      undoStack: [],
    }
    applyTabPersistSync(next)
    setTabsData([...merged, next])
    setActiveTabId(nid)
  }, [applyTabPersistSync])

  const closeBoardTab = useCallback(
    (id: string) => {
      if (tabsDataRef.current.length <= 1) {
        setError('至少保留一个画板。')
        window.setTimeout(() => setError(null), 2200)
        return
      }
      const curId = activeTabIdRef.current
      const c = latestCircuitRef.current
      const ui = latestBoardUiRef.current
      const curCirc = cloneCircuitSnapshot(
        c.branches,
        c.positions,
        c.groundId,
        c.nextId,
        c.probes,
        c.voltageProbes
      )
      let merged = buildFlushedTabsList(
        tabsDataRef.current,
        curId,
        curCirc,
        ui.solved,
        ui.error,
        ui.pruneMsg,
        undoStackRef.current
      )
      const closedName =
        merged.find((t) => t.id === id)?.name ?? '画板'
      merged = merged.filter((t) => t.id !== id)
      const wasActive = id === curId
      if (wasActive) {
        const pick = merged[0]
        applyTabPersistSync(pick)
        setActiveTabId(pick.id)
      }
      setTabsData(merged)
      setTabCtxMenu(null)
      const nextName = merged[0]?.name ?? '画板'
      const msg = wasActive
        ? `已关闭画板「${closedName}」，已切换到「${nextName}」。`
        : `已关闭后台画板「${closedName}」。`
      if (tabNoticeTimerRef.current) clearTimeout(tabNoticeTimerRef.current)
      setTabNotice(msg)
      tabNoticeTimerRef.current = window.setTimeout(() => {
        setTabNotice(null)
        tabNoticeTimerRef.current = null
      }, 2800)
    },
    [applyTabPersistSync]
  )

  const closeTabRenameModal = useCallback(() => {
    setTabRename(null)
    setTabRenameDraft('')
    setTabRenameErr(null)
  }, [])

  const applyTabRename = useCallback(() => {
    if (!tabRename) return
    const t = tabRenameDraft.trim()
    if (!t) {
      setTabRenameErr('请输入非空名称。')
      return
    }
    setTabsData((prev) =>
      prev.map((x) => (x.id === tabRename.id ? { ...x, name: t } : x))
    )
    closeTabRenameModal()
  }, [tabRename, tabRenameDraft, closeTabRenameModal])

  useEffect(() => {
    if (!tabRename) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeTabRenameModal()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tabRename, closeTabRenameModal])

  const onSvgContextMenu = (e: React.MouseEvent<SVGSVGElement>) => {
    e.preventDefault()
    const svg = svgRef.current
    if (!svg) return
    const { x, y } = svgPoint(svg, e.clientX, e.clientY)
    const vpr = pickVoltageProbeAt(voltageProbes, x, y, 30)
    const pr = pickProbeAt(probes, x, y, 30)
    const dv = vpr ? Math.hypot(vpr.x - x, vpr.y - y) : Infinity
    const dc = pr ? Math.hypot(pr.x - x, pr.y - y) : Infinity
    if (vpr && pr) {
      if (dv <= dc) {
        setCtxMenu({
          kind: 'vprobe',
          id: vpr.id,
          clientX: e.clientX,
          clientY: e.clientY,
        })
        closeEditModal()
        return
      }
      setCtxMenu({
        kind: 'probe',
        id: pr.id,
        clientX: e.clientX,
        clientY: e.clientY,
      })
      closeEditModal()
      return
    }
    if (vpr) {
      setCtxMenu({
        kind: 'vprobe',
        id: vpr.id,
        clientX: e.clientX,
        clientY: e.clientY,
      })
      closeEditModal()
      return
    }
    if (pr) {
      setCtxMenu({
        kind: 'probe',
        id: pr.id,
        clientX: e.clientX,
        clientY: e.clientY,
      })
      closeEditModal()
      return
    }
    const hitNode = nearestNode(positions, x, y, 14)
    if (hitNode !== null) {
      setCtxMenu({
        kind: 'node',
        nodeId: hitNode,
        clientX: e.clientX,
        clientY: e.clientY,
      })
      closeEditModal()
      return
    }
    const br = pickBranchAt(branches, positions, x, y, 16)
    if (br) {
      setCtxMenu({
        kind: 'branch',
        id: br.id,
        clientX: e.clientX,
        clientY: e.clientY,
      })
      closeEditModal()
      return
    }
    setCtxMenu(null)
  }

  const deleteCtxBranch = (id: string) => {
    pushCircuitUndo()
    setBranches((prev) => prev.filter((b) => b.id !== id))
    setProbes((prev) => prev.filter((p) => p.targetBranchId !== id))
    if (editBranchId === id) closeEditModal()
    if (editCs?.id === id) {
      setEditCs(null)
      setEditCsErr(null)
    }
    setSolved(null)
    setError(null)
    setCtxMenu(null)
  }

  const swapDirectedBranchById = (id: string) => {
    pushCircuitUndo()
    setBranches((prev) =>
      prev.map((b) => {
        if (b.id !== id) return b
        if (b.kind === 'V') return { ...b, nPlus: b.nMinus, nMinus: b.nPlus }
        if (b.kind === 'I') return { ...b, nFrom: b.nTo, nTo: b.nFrom }
        if (b.kind === 'CS')
          return { ...b, nPlus: b.nMinus, nMinus: b.nPlus }
        return b
      })
    )
    setSolved(null)
    setError(null)
  }

  const swapCtxDirectedBranch = (id: string) => {
    swapDirectedBranchById(id)
    setCtxMenu(null)
  }

  const deleteCtxProbe = (id: string) => {
    pushCircuitUndo()
    setProbes((prev) => prev.filter((p) => p.id !== id))
    if (probeLabelEdit?.kind === 'current' && probeLabelEdit.id === id) {
      closeProbeLabelModal()
    }
    setSolved(null)
    setError(null)
    setCtxMenu(null)
  }

  const deleteCtxVoltProbe = (id: string) => {
    pushCircuitUndo()
    setVoltageProbes((prev) => prev.filter((v) => v.id !== id))
    if (
      probeLabelEdit?.kind === 'volt' &&
      probeLabelEdit.id === id
    ) {
      closeProbeLabelModal()
    }
    setSolved(null)
    setError(null)
    setCtxMenu(null)
  }

  const deleteCtxNode = (nodeId: number) => {
    pushCircuitUndo()
    const brNext = branches.filter((b) => {
      const [a, c] = branchEndpoints(b)
      return a !== nodeId && c !== nodeId
    })
    const probeNext = probes.filter((p) =>
      brNext.some((b) => b.id === p.targetBranchId)
    )
    const voltNext = voltageProbes.filter((v) => v.nodeId !== nodeId)
    const posNext = new Map(positions)
    posNext.delete(nodeId)
    const g = groundId === nodeId ? null : groundId
    setPending(null)
    closeEditModal()
    setProbes(probeNext)
    setVoltageProbes(voltNext)
    runCompact(brNext, posNext, g)
    setCtxMenu(null)
  }

  const onCanvasClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg) return
    if (tool === 'select' && ignoreNextSvgClickRef.current) {
      ignoreNextSvgClickRef.current = false
      return
    }
    const { x, y } = svgPoint(svg, e.clientX, e.clientY)
    const hitR = 18
    const hit = nearestNode(positions, x, y, hitR)

    if (tool === 'select') {
      const br = pickBranchAt(branches, positions, x, y, 16)
      if (br) {
        setCircuitSelection(EMPTY_CIRCUIT_SELECTION)
        if (br.kind === 'W') {
          setError(null)
          closeEditModal()
          return
        }
        if (br.kind === 'V' || br.kind === 'I' || br.kind === 'CS') {
          if (e.detail >= 2) {
            if (directedBranchSwapTimerRef.current !== null) {
              clearTimeout(directedBranchSwapTimerRef.current)
              directedBranchSwapTimerRef.current = null
            }
            if (br.kind === 'CS') {
              setEditBranchId(null)
              setEditCs({
                id: br.id,
                k: String(br.k),
                output: br.output,
                control: br.control,
                vPlus: br.vProbeLabelPlus,
                vMinus: br.vProbeLabelMinus,
                iProbe: br.iProbeLabel,
              })
              setEditCsErr(null)
            } else {
              setEditBranchId(br.id)
              setEditDraft(
                br.kind === 'V' ? String(br.volts) : String(br.amps)
              )
            }
            setModalErr(null)
            setError(null)
            return
          }
          if (directedBranchSwapTimerRef.current !== null) {
            clearTimeout(directedBranchSwapTimerRef.current)
            directedBranchSwapTimerRef.current = null
          }
          directedBranchSwapTimerRef.current = setTimeout(() => {
            directedBranchSwapTimerRef.current = null
            swapDirectedBranchById(br.id)
          }, 260)
          closeEditModal()
          setEditCs(null)
          return
        }
        if (br.kind === 'R') {
          setEditBranchId(br.id)
          setEditDraft(String(br.ohms))
          setModalErr(null)
          setError(null)
        }
      } else {
        closeEditModal()
        setCircuitSelection(EMPTY_CIRCUIT_SELECTION)
      }
      return
    }

    if (tool === 'probe') {
      const br = pickBranchAt(branches, positions, x, y, 16)
      if (!br) {
        setError('请点击电阻、电压源、电流源、受控源或导线的连接线附近放置探针。')
        return
      }
      pushCircuitUndo()
      setProbes((prev) => {
        const label = allocateProbeLabel(prev, voltageProbes)
        return [
          ...prev,
          {
            id: newId('Probe'),
            targetBranchId: br.id,
            x,
            y,
            label,
          },
        ]
      })
      setSolved(null)
      setError(null)
      setPruneMsg(null)
      return
    }

    if (tool === 'voltProbe') {
      const hitN = nearestNode(positions, x, y, 22)
      if (hitN === null) {
        setError('请点击电气节点（圆点）附近放置电压探针。')
        return
      }
      pushCircuitUndo()
      setVoltageProbes((prev) => {
        const label = allocateProbeLabel(probes, prev)
        return [
          ...prev,
          {
            id: newId('VP'),
            nodeId: hitN,
            x,
            y,
            label,
          },
        ]
      })
      setSolved(null)
      setError(null)
      setPruneMsg(null)
      return
    }

    if (tool === 'node') {
      pushCircuitUndo()
      const id = nextId
      const p = new Map(positions)
      p.set(id, { x, y })
      setPositions(p)
      setNextId(id + 1)
      setSolved(null)
      setError(null)
      setPruneMsg(null)
      return
    }

    if (tool === 'gnd') {
      if (hit === null) {
        setError('请点击已有节点作为接地。')
        return
      }
      pushCircuitUndo()
      setGroundId(hit)
      setSolved(null)
      setError(null)
      return
    }

    if (tool === 'cSource' && !csPlaceParams) {
      setError('请先填写受控源参数。')
      setCsWizardOpen(true)
      setCsWizardErr('请先完成弹窗中的 k、控制方式与探针代号。')
      return
    }

    if (hit === null) {
      if (tool === 'cSource' && csPlaceParams) {
        setError('请点击节点（小圆点）。')
        return
      }
      setError('请点击节点（小圆点）上完成此操作。')
      return
    }

    if (tool === 'wire') {
      if (pending === null) {
        setPending(hit)
        setError(null)
        return
      }
      if (pending === hit) {
        setPending(null)
        return
      }
      const a = pending
      const b = hit
      const dup = branches.some(
        (br) =>
          br.kind === 'W' &&
          ((br.n1 === a && br.n2 === b) || (br.n1 === b && br.n2 === a))
      )
      if (dup) {
        setError('这两个节点之间已有导线。')
        setPending(null)
        return
      }
      const w: BranchW = {
        id: newId('W'),
        kind: 'W',
        n1: a,
        n2: b,
      }
      setPending(null)
      pushCircuitUndo()
      runCompact([...branches, w], positions, groundId)
      return
    }

    if (tool === 'R') {
      if (pending === null) {
        setPending(hit)
        setError(null)
        return
      }
      if (pending === hit) {
        setPending(null)
        return
      }
      const r: BranchR = {
        id: newId('R'),
        kind: 'R',
        n1: pending,
        n2: hit,
        ohms: defaultR,
      }
      setPending(null)
      pushCircuitUndo()
      runCompact([...branches, r], positions, groundId)
      return
    }

    if (tool === 'V') {
      if (pending === null) {
        setPending(hit)
        setError(null)
        return
      }
      if (pending === hit) {
        setPending(null)
        return
      }
      const v: BranchV = {
        id: newId('V'),
        kind: 'V',
        nPlus: pending,
        nMinus: hit,
        volts: defaultV,
      }
      setPending(null)
      pushCircuitUndo()
      runCompact([...branches, v], positions, groundId)
      return
    }

    if (tool === 'I') {
      if (pending === null) {
        setPending(hit)
        setError(null)
        return
      }
      if (pending === hit) {
        setPending(null)
        return
      }
      const ii: BranchI = {
        id: newId('I'),
        kind: 'I',
        nFrom: pending,
        nTo: hit,
        amps: defaultI,
      }
      setPending(null)
      pushCircuitUndo()
      runCompact([...branches, ii], positions, groundId)
      return
    }

    if (tool === 'cSource') {
      const spec = csPlaceParams
      if (!spec) {
        setError('受控源参数丢失，请重新填写。')
        setCsWizardOpen(true)
        setCsWizardErr('请先完成弹窗中的参数。')
        return
      }
      if (pending === null) {
        setPending(hit)
        setError(null)
        return
      }
      if (pending === hit) {
        setPending(null)
        return
      }
      const cs: BranchCS = {
        id: newId('CS'),
        kind: 'CS',
        nPlus: pending,
        nMinus: hit,
        output: spec.output,
        control: spec.control,
        k: spec.k,
        vProbeLabelPlus: spec.vProbeLabelPlus,
        vProbeLabelMinus: spec.vProbeLabelMinus,
        iProbeLabel: spec.iProbeLabel,
      }
      setPending(null)
      setCsPlaceParams(null)
      setTool('select')
      setCsWizardOpen(false)
      pushCircuitUndo()
      runCompact([...branches, cs], positions, groundId)
      return
    }
  }

  const analyze = () => {
    pushCircuitUndo()
    closeEditModal()
    closeProbeLabelModal()
    setCtxMenu(null)
    setPruneMsg(null)
    const before = positions.size
    const pruned = pruneOrphans(positions, branches)
    if (pruned.size < before) {
      setPruneMsg(`已移除 ${before - pruned.size} 个未连支路的悬空节点。`)
    }
    const prunedKeys = new Set(pruned.keys())
    const vpFiltered = voltageProbes.filter((v) => prunedKeys.has(v.nodeId))
    const compacted = applyCompact(branches, pruned, groundId)
    const vpMapped = vpFiltered.map((v) => {
      const nn = compacted.idMap.get(v.nodeId)
      return nn !== undefined ? { ...v, nodeId: nn } : null
    })
    const vpNext = vpMapped.filter((x): x is VoltageProbe => x !== null)
    setBranches(compacted.branches)
    setPositions(compacted.positions)
    setGroundId(compacted.groundId)
    setNextId(compacted.nextId)
    setVoltageProbes(vpNext)

    const used = nodesUsedInBranches(compacted.branches)
    const numNodes =
      used.size === 0 ? 0 : Math.max(...used) + 1

    const branchIds = new Set(compacted.branches.map((b) => b.id))
    const probesForSolve = probes.filter((p) =>
      branchIds.has(p.targetBranchId)
    )
    const needsProbeOpts = compacted.branches.some((b) => b.kind === 'CS')

    const err = validateBeforeSolve(numNodes, compacted.groundId, compacted.branches)
    if (err) {
      setError(err.message)
      setSolved(null)
      return
    }

    const res = solveDcMna(
      numNodes,
      compacted.groundId!,
      compacted.branches,
      needsProbeOpts
        ? { voltageProbes: vpNext, currentProbes: probesForSolve }
        : undefined
    )
    if (res.ok) {
      setError(null)
      setSolved(res)
    } else {
      setError((res as SolveErr).message)
      setSolved(null)
    }
  }

  const clearAll = () => {
    if (directedBranchSwapTimerRef.current !== null) {
      clearTimeout(directedBranchSwapTimerRef.current)
      directedBranchSwapTimerRef.current = null
    }
    pushCircuitUndo()
    setBranches([])
    setPositions(new Map())
    setNextId(0)
    setGroundId(null)
    setPending(null)
    setSolved(null)
    setError(null)
    setPruneMsg(null)
    setEditBranchId(null)
    setModalErr(null)
    setCsPlaceParams(null)
    setCsWizardOpen(false)
    setCsWizardErr(null)
    setEditCs(null)
    setEditCsErr(null)
    setProbes([])
    setVoltageProbes([])
    closeProbeLabelModal()
    setCtxMenu(null)
    setCircuitSelection(EMPTY_CIRCUIT_SELECTION)
  }

  const ctxMenuBranchKind =
    ctxMenu?.kind === 'branch'
      ? branches.find((b) => b.id === ctxMenu.id)?.kind
      : undefined
  const ctxMenuIsSwappableBranch =
    ctxMenuBranchKind === 'V' ||
    ctxMenuBranchKind === 'I' ||
    ctxMenuBranchKind === 'CS'
  const ctxMenuTwoButtonStack =
    ctxMenuIsSwappableBranch ||
    ctxMenu?.kind === 'vprobe' ||
    ctxMenu?.kind === 'probe'

  const applyCsWizardModal = () => {
    const k = Number(csK.trim())
    if (!Number.isFinite(k)) {
      setCsWizardErr('比例系数 k 必须是有效数字。')
      return
    }
    if (csControl === 'volt') {
      const a = csVPlus.trim()
      const b = csVMinus.trim()
      if (!a || !b) {
        setCsWizardErr('电压控制须填写两个电压探针代号。')
        return
      }
      const hasA = voltageProbes.some((v) => v.label.trim() === a)
      const hasB = voltageProbes.some((v) => v.label.trim() === b)
      if (!hasA || !hasB) {
        setCsWizardErr('两个电压探针代号均须对应已放置的电压探针。')
        return
      }
      setCsPlaceParams({
        output: csOutput,
        control: 'volt',
        k,
        vProbeLabelPlus: a,
        vProbeLabelMinus: b,
        iProbeLabel: '',
      })
    } else {
      const t = csIProbe.trim()
      if (!t) {
        setCsWizardErr('电流控制须填写电流探针代号。')
        return
      }
      const hasP = probes.some((p) => p.label.trim() === t)
      if (!hasP) {
        setCsWizardErr('电流探针代号须对应已放置的电流探针。')
        return
      }
      setCsPlaceParams({
        output: csOutput,
        control: 'curr',
        k,
        vProbeLabelPlus: '',
        vProbeLabelMinus: '',
        iProbeLabel: t,
      })
    }
    setCsWizardOpen(false)
    setCsWizardErr(null)
    setError(null)
  }

  const applyCsEditModal = () => {
    if (!editCs) return
    const k = Number(editCs.k.trim())
    if (!Number.isFinite(k)) {
      setEditCsErr('比例系数 k 必须是有效数字。')
      return
    }
    if (editCs.control === 'volt') {
      const a = editCs.vPlus.trim()
      const b = editCs.vMinus.trim()
      if (!a || !b) {
        setEditCsErr('电压控制须填写两个电压探针代号。')
        return
      }
      const hasA = voltageProbes.some((v) => v.label.trim() === a)
      const hasB = voltageProbes.some((v) => v.label.trim() === b)
      if (!hasA || !hasB) {
        setEditCsErr('两个电压探针代号均须对应已放置的电压探针。')
        return
      }
      pushCircuitUndo()
      setBranches((prev) =>
        prev.map((br) => {
          if (br.id !== editCs.id || br.kind !== 'CS') return br
          return {
            ...br,
            k,
            output: editCs.output,
            control: 'volt',
            vProbeLabelPlus: a,
            vProbeLabelMinus: b,
            iProbeLabel: '',
          }
        })
      )
    } else {
      const t = editCs.iProbe.trim()
      if (!t) {
        setEditCsErr('电流控制须填写电流探针代号。')
        return
      }
      const hasP = probes.some((p) => p.label.trim() === t)
      if (!hasP) {
        setEditCsErr('电流探针代号须对应已放置的电流探针。')
        return
      }
      pushCircuitUndo()
      setBranches((prev) =>
        prev.map((br) => {
          if (br.id !== editCs.id || br.kind !== 'CS') return br
          return {
            ...br,
            k,
            output: editCs.output,
            control: 'curr',
            vProbeLabelPlus: '',
            vProbeLabelMinus: '',
            iProbeLabel: t,
          }
        })
      )
    }
    setSolved(null)
    setError(null)
    closeEditModal()
  }

  const applyEditModal = () => {
    if (!editBranchId) return
    const br = branches.find((b) => b.id === editBranchId)
    if (!br) {
      closeEditModal()
      return
    }
    if (br.kind === 'W' || br.kind === 'CS') {
      closeEditModal()
      return
    }
    const num = Number(editDraft)
    if (!Number.isFinite(num)) {
      setModalErr('请输入有效数字。')
      return
    }
    if (br.kind === 'R') {
      if (num <= 0) {
        setModalErr('电阻必须大于 0。')
        return
      }
    }
    pushCircuitUndo()
    setBranches((prev) =>
      prev.map((b) => {
        if (b.id !== editBranchId) return b
        if (b.kind === 'R') return { ...b, ohms: num }
        if (b.kind === 'V') return { ...b, volts: num }
        return { ...b, amps: num }
      })
    )
    setSolved(null)
    setError(null)
    closeEditModal()
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>简易直流电路分析（第一阶段）</h1>
        <div className="board-tab-strip">
          <div
            ref={tabListRef}
            className="board-tab-list"
            role="tablist"
            aria-label="画板切换"
          >
            {tabsData.map((tab) => (
              <div
                key={tab.id}
                data-tab-id={tab.id}
                role="tab"
                tabIndex={0}
                aria-selected={tab.id === activeTabId}
                className={
                  'board-tab' +
                  (tab.id === activeTabId ? ' board-tab--active' : '')
                }
                onDragOver={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  e.dataTransfer.dropEffect = 'move'
                  if (!dragTabIdRef.current) return
                  pendingTabDragRef.current = {
                    tabId: tab.id,
                    clientX: e.clientX,
                  }
                  if (tabDragRafRef.current == null) {
                    tabDragRafRef.current = requestAnimationFrame(
                      flushTabDragOver
                    )
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  tabReorderSuppressClickUntilRef.current = Date.now() + 400
                }}
                onClick={() => {
                  if (Date.now() < tabReorderSuppressClickUntilRef.current)
                    return
                  switchToTab(tab.id)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    if (Date.now() < tabReorderSuppressClickUntilRef.current)
                      return
                    switchToTab(tab.id)
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setTabCtxMenu({
                    id: tab.id,
                    clientX: e.clientX,
                    clientY: e.clientY,
                  })
                }}
              >
                <span
                  className="board-tab-name"
                  title={`${tab.name}（按住名称拖动，经过其它标签时实时换位；松手即定序）`}
                  draggable
                  onDragStart={(ev) => {
                    ev.stopPropagation()
                    dragTabIdRef.current = tab.id
                    ev.dataTransfer.setData('text/plain', tab.id)
                    ev.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragEnd={() => {
                    if (tabDragRafRef.current != null) {
                      cancelAnimationFrame(tabDragRafRef.current)
                      tabDragRafRef.current = null
                    }
                    const dragId = dragTabIdRef.current
                    const p = pendingTabDragRef.current
                    pendingTabDragRef.current = null
                    if (p && dragId) {
                      const root = tabListRef.current
                      const el = root
                        ? (Array.from(
                            root.querySelectorAll('[data-tab-id]')
                          ).find(
                            (node) =>
                              (node as HTMLElement).dataset.tabId === p.tabId
                          ) as HTMLElement | undefined)
                        : undefined
                      if (el) {
                        const rect = el.getBoundingClientRect()
                        const placeAfter =
                          p.clientX > rect.left + rect.width / 2
                        const next = reorderTabsDuringDrag(
                          tabsDataRef.current,
                          dragId,
                          p.tabId,
                          placeAfter
                        )
                        if (next) {
                          tabFlipBeforeRef.current = measureBoardTabRects()
                          setTabsData(next)
                        }
                      }
                    }
                    dragTabIdRef.current = null
                  }}
                >
                  {tab.name}
                </span>
                <button
                  type="button"
                  className="board-tab-close"
                  aria-label={`关闭 ${tab.name}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    closeBoardTab(tab.id)
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="board-tab-new"
            onClick={addBoardTab}
          >
            + 新建画板
          </button>
        </div>
        {tabNotice && (
          <div className="tab-notice" role="status" aria-live="polite">
            {tabNotice}
          </div>
        )}
        <p>
          放置节点、电阻、电压源、电流源；用「导线」工具在两节点间画连线（不合并节点）；用电流/电压探针读支路电流与节点电势（相对接地）。指定接地后点击「求解」。电阻单击打开编辑；电压源与电流源均为单击调换参考方向、双击改参数。在节点、支路或探针上右键可删除（电压源与电流源还可调换；电流/电压探针可命名，且任意两探针代号不得相同）。「撤回」可撤销上一步电路相关操作（可多次点击逐步退回，最多约 60 步）。
        </p>
      </header>

      <div className="toolbar">
        <button
          type="button"
          className={tool === 'select' ? 'active' : ''}
          title="编辑（位置固定）"
          onClick={() => activateTool('select')}
        >
          {TOOL_LABELS.select}
        </button>
        <div ref={toolbarListRef} className="toolbar-tool-buttons">
          {toolbarToolOrder.map((tid) => (
            <button
              key={tid}
              type="button"
              data-toolbar-tool={tid}
              title={`${TOOL_LABELS[tid]}（按住拖动可调整顺序）`}
              draggable
              className={tool === tid ? 'active' : ''}
              onDragOver={(e) => {
                e.preventDefault()
                e.stopPropagation()
                e.dataTransfer.dropEffect = 'move'
                if (!toolbarDragIdRef.current) return
                pendingToolbarDragRef.current = {
                  toolId: tid,
                  clientX: e.clientX,
                }
                if (toolbarDragRafRef.current == null) {
                  toolbarDragRafRef.current = requestAnimationFrame(
                    flushToolbarDragOver
                  )
                }
              }}
              onDrop={(e) => {
                e.preventDefault()
                e.stopPropagation()
                toolbarReorderSuppressClickUntilRef.current =
                  Date.now() + 400
              }}
              onClick={() => {
                if (
                  Date.now() < toolbarReorderSuppressClickUntilRef.current
                )
                  return
                activateTool(tid)
              }}
              onDragStart={(ev) => {
                ev.stopPropagation()
                toolbarDragIdRef.current = tid
                ev.dataTransfer.setData('text/plain', tid)
                ev.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={() => {
                if (toolbarDragRafRef.current != null) {
                  cancelAnimationFrame(toolbarDragRafRef.current)
                  toolbarDragRafRef.current = null
                }
                const dragId = toolbarDragIdRef.current
                const p = pendingToolbarDragRef.current
                pendingToolbarDragRef.current = null
                if (p && dragId) {
                  const root = toolbarListRef.current
                  const el = root
                    ? (Array.from(
                        root.querySelectorAll('[data-toolbar-tool]')
                      ).find(
                        (node) =>
                          (node as HTMLElement).dataset.toolbarTool ===
                          p.toolId
                      ) as HTMLElement | undefined)
                    : undefined
                  if (el) {
                    const rect = el.getBoundingClientRect()
                    const placeAfter =
                      p.clientX > rect.left + rect.width / 2
                    const next = reorderDraggableIdsDuringDrag<DraggableToolbarTool>(
                      toolbarToolOrderRef.current,
                      dragId,
                      p.toolId,
                      placeAfter
                    )
                    if (next) {
                      toolbarFlipBeforeRef.current =
                        measureToolbarToolRects()
                      setToolbarToolOrder(next)
                    }
                  }
                }
                toolbarDragIdRef.current = null
              }}
            >
              {TOOL_LABELS[tid]}
            </button>
          ))}
        </div>
        <button
          type="button"
          title="撤回最近一次对电路的修改（含求解前的整理）；位置固定"
          disabled={!undoAvailable}
          onClick={undoCircuit}
        >
          撤回
        </button>
        <span className="sep" aria-hidden />
        <label>
          默认 R (Ω)
          <input
            type="number"
            min={1e-9}
            step="any"
            value={defaultR}
            onChange={(e) => setDefaultR(Number(e.target.value))}
          />
        </label>
        <label>
          默认 V (V)
          <input
            type="number"
            step="any"
            value={defaultV}
            onChange={(e) => setDefaultV(Number(e.target.value))}
          />
        </label>
        <label>
          默认 I (A)
          <input
            type="number"
            step="any"
            value={defaultI}
            onChange={(e) => setDefaultI(Number(e.target.value))}
          />
        </label>
        <span className="sep" aria-hidden />
        <button type="button" onClick={analyze}>
          求解
        </button>
        <button type="button" onClick={clearAll}>
          清空
        </button>
      </div>

      <div className="main-row">
        <div className="canvas-wrap">
          <svg
            ref={svgRef}
            className="circuit-canvas"
            viewBox="0 0 920 540"
            preserveAspectRatio="xMidYMid meet"
            width="100%"
            height="100%"
            onPointerDown={onSvgPointerDown}
            onPointerMove={onSvgPointerMove}
            onPointerUp={endCanvasPointer}
            onPointerCancel={endCanvasPointer}
            onClick={onCanvasClick}
            onContextMenu={onSvgContextMenu}
          >
            <defs>
              <marker
                id="arrow"
                markerWidth="8"
                markerHeight="8"
                refX="6"
                refY="4"
                orient="auto"
              >
                <path d="M0,0 L8,4 L0,8 z" fill="#1a5fb4" />
              </marker>
              <marker
                id="arrow-i"
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="4"
                orient="auto"
              >
                <path d="M0,0 L8,4 L0,8 z" fill="#8b4513" />
              </marker>
              <marker
                id="probe-current-dir"
                markerUnits="userSpaceOnUse"
                markerWidth="5"
                markerHeight="5"
                refX="4.2"
                refY="2.5"
                orient="auto"
              >
                <path
                  d="M0,0.5 L4.2,2.5 L0,4.5 z"
                  fill="#116329"
                  stroke="none"
                />
              </marker>
              <marker
                id="arrow-cs"
                markerWidth="8"
                markerHeight="8"
                refX="7"
                refY="4"
                orient="auto"
              >
                <path d="M0,0 L8,4 L0,8 z" fill="#6d28d9" />
              </marker>
              <marker
                id="solve-read-leader"
                markerUnits="userSpaceOnUse"
                markerWidth="5"
                markerHeight="5"
                refX="4.2"
                refY="2.5"
                orient="auto"
              >
                <path
                  d="M0,0.6 L4.2,2.5 L0,4.4 z"
                  fill="#3d3d3d"
                  stroke="none"
                />
              </marker>
            </defs>

            {branches.map((b) => {
              const [na, nb] = branchEndpoints(b)
              const pa = positions.get(na)
              const pb = positions.get(nb)
              if (!pa || !pb) return null
              const m = mid(pa, pb)
              const isEdit = b.id === editBranchId || b.id === editCs?.id

              if (b.kind === 'R') {
                return (
                  <g key={b.id}>
                    <path
                      d={resistorPath(pa.x, pa.y, pb.x, pb.y)}
                      fill="none"
                      stroke="#222"
                      strokeWidth={2.2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={isEdit ? 'branch-hit' : undefined}
                    />
                    <circle cx={pa.x} cy={pa.y} r={5} fill="#222" />
                    <circle cx={pb.x} cy={pb.y} r={5} fill="#222" />
                  </g>
                )
              }

              if (b.kind === 'W') {
                return (
                  <g key={b.id}>
                    <line
                      x1={pa.x}
                      y1={pa.y}
                      x2={pb.x}
                      y2={pb.y}
                      stroke="#4a5568"
                      strokeWidth={3.5}
                      strokeLinecap="round"
                      className={isEdit ? 'branch-hit' : undefined}
                    />
                  </g>
                )
              }

              if (b.kind === 'V') {
                const vg = voltageBatteryGeometry(pa, pb)
                const hitClass = isEdit ? ' v-battery-g--hit' : ''
                return (
                  <g key={b.id} className={'v-battery-g' + hitClass}>
                    <line
                      x1={vg.pa.x}
                      y1={vg.pa.y}
                      x2={vg.paJoin.x}
                      y2={vg.paJoin.y}
                    />
                    <line
                      x1={vg.longA.x}
                      y1={vg.longA.y}
                      x2={vg.longB.x}
                      y2={vg.longB.y}
                    />
                    <line
                      x1={vg.shortA.x}
                      y1={vg.shortA.y}
                      x2={vg.shortB.x}
                      y2={vg.shortB.y}
                    />
                    <line
                      x1={vg.pbJoin.x}
                      y1={vg.pbJoin.y}
                      x2={vg.pb.x}
                      y2={vg.pb.y}
                    />
                    <circle cx={pa.x} cy={pa.y} r={5} fill="#1a5fb4" />
                    <circle cx={pb.x} cy={pb.y} r={5} fill="#1a5fb4" />
                  </g>
                )
              }

              if (b.kind === 'CS' && b.output === 'V') {
                const vg = voltageBatteryGeometry(pa, pb)
                const hitClass = isEdit ? ' v-battery-g--hit' : ''
                return (
                  <g key={b.id} className={'v-battery-g cs-battery-g' + hitClass}>
                    <line
                      x1={vg.pa.x}
                      y1={vg.pa.y}
                      x2={vg.paJoin.x}
                      y2={vg.paJoin.y}
                      stroke="#6d28d9"
                    />
                    <line
                      x1={vg.longA.x}
                      y1={vg.longA.y}
                      x2={vg.longB.x}
                      y2={vg.longB.y}
                      stroke="#6d28d9"
                    />
                    <line
                      x1={vg.shortA.x}
                      y1={vg.shortA.y}
                      x2={vg.shortB.x}
                      y2={vg.shortB.y}
                      stroke="#6d28d9"
                    />
                    <line
                      x1={vg.pbJoin.x}
                      y1={vg.pbJoin.y}
                      x2={vg.pb.x}
                      y2={vg.pb.y}
                      stroke="#6d28d9"
                    />
                    <circle cx={pa.x} cy={pa.y} r={5} fill="#6d28d9" />
                    <circle cx={pb.x} cy={pb.y} r={5} fill="#6d28d9" />
                  </g>
                )
              }

              if (b.kind === 'CS' && b.output === 'I') {
                return (
                  <g key={b.id}>
                    <line
                      x1={pb.x}
                      y1={pb.y}
                      x2={pa.x}
                      y2={pa.y}
                      stroke="#6d28d9"
                      strokeWidth={2.8}
                      strokeDasharray="6 4"
                      markerEnd="url(#arrow-cs)"
                      className={isEdit ? 'branch-hit' : undefined}
                    />
                    <circle
                      cx={m.x}
                      cy={m.y}
                      r={15}
                      fill="#f5f3ff"
                      stroke="#6d28d9"
                      strokeWidth={2}
                      className={isEdit ? 'branch-hit' : undefined}
                    />
                    <text
                      x={m.x}
                      y={m.y + 4}
                      textAnchor="middle"
                      fontSize="11"
                      fill="#4c1d95"
                      fontWeight="600"
                      style={{ userSelect: 'none' }}
                    >
                      CS
                    </text>
                    <circle cx={pa.x} cy={pa.y} r={5} fill="#6d28d9" />
                    <circle cx={pb.x} cy={pb.y} r={5} fill="#6d28d9" />
                  </g>
                )
              }

              if (b.kind === 'I') {
                return (
                  <g key={b.id}>
                    <line
                      x1={pb.x}
                      y1={pb.y}
                      x2={pa.x}
                      y2={pa.y}
                      stroke="#8b4513"
                      strokeWidth={2.8}
                      strokeDasharray="6 4"
                      markerEnd="url(#arrow-i)"
                      className={isEdit ? 'branch-hit' : undefined}
                    />
                    <circle
                      cx={m.x}
                      cy={m.y}
                      r={15}
                      fill="#fff7ed"
                      stroke="#8b4513"
                      strokeWidth={2}
                      className={isEdit ? 'branch-hit' : undefined}
                    />
                    <text
                      x={m.x}
                      y={m.y + 4}
                      textAnchor="middle"
                      fontSize="11"
                      fill="#5c2e08"
                      fontWeight="600"
                      style={{ userSelect: 'none' }}
                    >
                      I
                    </text>
                    <circle cx={pa.x} cy={pa.y} r={5} fill="#8b4513" />
                    <circle cx={pb.x} cy={pb.y} r={5} fill="#8b4513" />
                  </g>
                )
              }

              return null
            })}

            {[...positions.entries()].map(([id, p]) => {
              const vg = groundId === id
              return (
                <g key={id}>
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={vg ? 9 : 7}
                    fill={vg ? '#2d5016' : '#c53b2b'}
                    stroke="#111"
                    strokeWidth={1.5}
                  />
                  {vg && (
                    <g transform={`translate(${p.x - 12}, ${p.y + 14})`}>
                      <line x1={0} y1={0} x2={24} y2={0} stroke="#2d5016" strokeWidth={2} />
                      <line x1={4} y1={5} x2={20} y2={5} stroke="#2d5016" strokeWidth={2} />
                      <line x1={8} y1={10} x2={16} y2={10} stroke="#2d5016" strokeWidth={2} />
                    </g>
                  )}
                </g>
              )
            })}

            {probes.map((p) => {
              const ang = probePenAngleDeg(p, branches, positions)
              const br = branches.find((x) => x.id === p.targetBranchId)
              const dirGeo =
                br !== undefined
                  ? branchCurrentDirectionGeometry(
                      br,
                      positions,
                      p.x,
                      p.y
                    )
                  : null
              const bi = branches.findIndex((x) => x.id === p.targetBranchId)
              let flip = false
              if (
                solved &&
                bi >= 0 &&
                bi < solved.branchCurrents.length &&
                Number.isFinite(solved.branchCurrents[bi])
              ) {
                flip = solved.branchCurrents[bi] < 0
              }
              const sx =
                dirGeo !== null ? (flip ? -dirGeo.tx : dirGeo.tx) : 1
              const sy =
                dirGeo !== null ? (flip ? -dirGeo.ty : dirGeo.ty) : 0
              return (
                <g key={p.id}>
                  <g transform={`translate(${p.x},${p.y}) rotate(${ang})`}>
                    <path
                      d="M 0 0 L 18 4.5 L 13 0 L 18 -4.5 Z"
                      fill="#238636"
                      stroke="#116329"
                      strokeWidth="0.9"
                      strokeLinejoin="round"
                    />
                    <line
                      x1="-3"
                      y1="0"
                      x2="-40"
                      y2="0"
                      stroke="#2ea043"
                      strokeWidth="10"
                      strokeLinecap="round"
                    />
                    <line
                      x1="-5"
                      y1="0"
                      x2="-34"
                      y2="0"
                      stroke="#56d364"
                      strokeWidth="4"
                      strokeLinecap="round"
                    />
                    <line
                      x1="-22"
                      y1="-5"
                      x2="-18"
                      y2="5"
                      stroke="#116329"
                      strokeWidth="1.2"
                      strokeOpacity="0.45"
                    />
                  </g>
                  {dirGeo !== null && (
                    <line
                      className="probe-current-dir-arrow"
                      x1={dirGeo.ax - sx * 5.5}
                      y1={dirGeo.ay - sy * 5.5}
                      x2={dirGeo.ax + sx * 3}
                      y2={dirGeo.ay + sy * 3}
                      stroke="#116329"
                      strokeWidth={1.35}
                      strokeLinecap="round"
                      markerEnd="url(#probe-current-dir)"
                    />
                  )}
                </g>
              )
            })}

            {voltageProbes.map((vp) => {
              const ang = voltProbePenAngleDeg(vp, positions)
              return (
                <g key={vp.id}>
                  <g transform={`translate(${vp.x},${vp.y}) rotate(${ang})`}>
                    <path
                      d="M 0 0 L 18 4.5 L 13 0 L 18 -4.5 Z"
                      fill="#d4a72d"
                      stroke="#9a6700"
                      strokeWidth="0.9"
                      strokeLinejoin="round"
                    />
                    <line
                      x1="-3"
                      y1="0"
                      x2="-40"
                      y2="0"
                      stroke="#bf8700"
                      strokeWidth="10"
                      strokeLinecap="round"
                    />
                    <line
                      x1="-5"
                      y1="0"
                      x2="-34"
                      y2="0"
                      stroke="#f0d78c"
                      strokeWidth="4"
                      strokeLinecap="round"
                    />
                    <line
                      x1="-22"
                      y1="-5"
                      x2="-18"
                      y2="5"
                      stroke="#9a6700"
                      strokeWidth="1.2"
                      strokeOpacity="0.45"
                    />
                  </g>
                </g>
              )
            })}

            {tool === 'select' &&
              (selectedNodeSet.size > 0 ||
                selectedCurrentProbeSet.size > 0 ||
                selectedVoltageProbeSet.size > 0) && (
                <g className="circuit-selection-highlights" pointerEvents="none">
                  {circuitSelection.nodeIds.map((nid) => {
                    const pt = positions.get(nid)
                    if (!pt) return null
                    return (
                      <circle
                        key={`sel-node-${nid}`}
                        cx={pt.x}
                        cy={pt.y}
                        r={12}
                        fill="none"
                        stroke="#58a6ff"
                        strokeWidth={2}
                        strokeDasharray="4 3"
                      />
                    )
                  })}
                  {probes
                    .filter((p) => selectedCurrentProbeSet.has(p.id))
                    .map((p) => (
                      <circle
                        key={`sel-cprobe-${p.id}`}
                        cx={p.x}
                        cy={p.y}
                        r={16}
                        fill="none"
                        stroke="#58a6ff"
                        strokeWidth={2}
                        strokeDasharray="4 3"
                      />
                    ))}
                  {voltageProbes
                    .filter((v) => selectedVoltageProbeSet.has(v.id))
                    .map((v) => (
                      <circle
                        key={`sel-vprobe-${v.id}`}
                        cx={v.x}
                        cy={v.y}
                        r={16}
                        fill="none"
                        stroke="#58a6ff"
                        strokeWidth={2}
                        strokeDasharray="4 3"
                      />
                    ))}
                </g>
              )}
            {tool === 'select' &&
              marqueeRect &&
              marqueeRect.w > 0.5 &&
              marqueeRect.h > 0.5 && (
                <rect
                  className="circuit-marquee-rect"
                  x={marqueeRect.x}
                  y={marqueeRect.y}
                  width={marqueeRect.w}
                  height={marqueeRect.h}
                  fill="rgba(88, 166, 255, 0.08)"
                  stroke="#58a6ff"
                  strokeWidth={1.2}
                  strokeDasharray="5 4"
                  pointerEvents="none"
                />
              )}

            <g className="circuit-overlay-labels">
              {branches.map((b) => {
                const t = circuitOverlayLayout.branchTags.get(b.id)
                if (!t) return null
                return (
                  <foreignObject
                    key={`branch-anno-${b.id}`}
                    x={t.x}
                    y={t.y}
                    width={t.w}
                    height={t.h}
                  >
                    <div
                      className={`circuit-anno-tag circuit-anno-tag--branch circuit-param-nobox circuit-anno-tag--${t.kind}`}
                      {...({
                        xmlns: 'http://www.w3.org/1999/xhtml',
                      } as Record<string, string>)}
                    >
                      <div>{t.line1}</div>
                      {t.line2 && (
                        <div className="anno-second">{t.line2}</div>
                      )}
                    </div>
                  </foreignObject>
                )
              })}
              {probes.map((p) => {
                const t = circuitOverlayLayout.currentProbeTags.get(p.id)
                if (!t) return null
                return (
                  <foreignObject
                    key={`probe-anno-${p.id}`}
                    x={t.x}
                    y={t.y}
                    width={t.w}
                    height={t.h}
                  >
                    <div
                      className="circuit-anno-tag circuit-param-nobox circuit-anno-tag--probe-i"
                      title={t.label}
                      {...({
                        xmlns: 'http://www.w3.org/1999/xhtml',
                      } as Record<string, string>)}
                    >
                      {t.label}
                    </div>
                  </foreignObject>
                )
              })}
              {voltageProbes.map((vp) => {
                const t = circuitOverlayLayout.voltProbeTags.get(vp.id)
                if (!t) return null
                return (
                  <foreignObject
                    key={`vprobe-anno-${vp.id}`}
                    x={t.x}
                    y={t.y}
                    width={t.w}
                    height={t.h}
                  >
                    <div
                      className="circuit-anno-tag circuit-param-nobox circuit-anno-tag--probe-v"
                      title={t.label}
                      {...({
                        xmlns: 'http://www.w3.org/1999/xhtml',
                      } as Record<string, string>)}
                    >
                      {t.label}
                    </div>
                  </foreignObject>
                )
              })}
              {solved &&
                probes.map((p) => {
                  const reading = probeAmpReading(p, branches, solved)
                  const pop =
                    reading !== null
                      ? circuitOverlayLayout.solveCurrentById.get(p.id) ??
                        null
                      : null
                  if (!pop || reading === null) return null
                  return (
                    <foreignObject
                      key={`probe-read-${p.id}`}
                      x={pop.x}
                      y={pop.y}
                      width={PROBE_POP_W}
                      height={PROBE_POP_H}
                    >
                      <div
                        className="probe-read-bubble"
                        {...({
                          xmlns: 'http://www.w3.org/1999/xhtml',
                        } as Record<string, string>)}
                      >
                        <div className="probe-pop-title">{p.label}</div>
                        <div className="probe-pop-value">I = {reading} A</div>
                      </div>
                    </foreignObject>
                  )
                })}
              {solved &&
                voltageProbes.map((vp) => {
                  const reading = voltageProbeReading(
                    vp,
                    solved,
                    groundId
                  )
                  const pop =
                    reading !== null
                      ? circuitOverlayLayout.solveVoltById.get(vp.id) ?? null
                      : null
                  if (!pop || reading === null) return null
                  return (
                    <foreignObject
                      key={`vprobe-read-${vp.id}`}
                      x={pop.x}
                      y={pop.y}
                      width={VOLT_POP_W}
                      height={VOLT_POP_H}
                    >
                      <div
                        className="voltage-read-bubble"
                        {...({
                          xmlns: 'http://www.w3.org/1999/xhtml',
                        } as Record<string, string>)}
                      >
                        <div className="volt-pop-title">{vp.label}</div>
                        <div className="volt-pop-value">
                          U = {reading} V（相对接地）
                        </div>
                      </div>
                    </foreignObject>
                  )
                })}
              {solved && (
                <g className="solve-read-leaders" pointerEvents="none">
                  {probes.map((p) => {
                    const reading = probeAmpReading(p, branches, solved)
                    const pop =
                      reading !== null
                        ? circuitOverlayLayout.solveCurrentById.get(p.id) ??
                          null
                        : null
                    if (!pop || reading === null) return null
                    const L = solveReadLeaderForCurrentProbe(
                      p,
                      branches,
                      positions,
                      pop,
                      PROBE_POP_W,
                      PROBE_POP_H
                    )
                    if (!L) return null
                    return (
                      <line
                        key={`probe-leader-${p.id}`}
                        className="solve-read-leader-line"
                        x1={L.x1}
                        y1={L.y1}
                        x2={L.x2}
                        y2={L.y2}
                        markerEnd="url(#solve-read-leader)"
                      />
                    )
                  })}
                  {voltageProbes.map((vp) => {
                    const reading = voltageProbeReading(
                      vp,
                      solved,
                      groundId
                    )
                    const pop =
                      reading !== null
                        ? circuitOverlayLayout.solveVoltById.get(vp.id) ??
                          null
                        : null
                    if (!pop || reading === null) return null
                    const L = solveReadLeaderForVoltageProbe(
                      vp,
                      positions,
                      groundId,
                      pop,
                      VOLT_POP_W,
                      VOLT_POP_H
                    )
                    if (!L) return null
                    return (
                      <line
                        key={`vprobe-leader-${vp.id}`}
                        className="solve-read-leader-line"
                        x1={L.x1}
                        y1={L.y1}
                        x2={L.x2}
                        y2={L.y2}
                        markerEnd="url(#solve-read-leader)"
                      />
                    )
                  })}
                </g>
              )}
            </g>
          </svg>
        </div>

        <aside className="side-panel">
          <h2>操作说明</h2>
          <p className="hint">{toolHint}</p>
          {pruneMsg && <p className="hint">{pruneMsg}</p>}
          {error && <div className="err">{error}</div>}
          {solved && !error && (
            <div className="ok-block">
              求解成功。参数与电流（若可算）已标在元件旁；电阻电流方向为 n1→n2；电压源、电流源、导线电流方向见类型定义。探针代号以小字贴在笔旁。
            </div>
          )}
        </aside>
      </div>

      {csWizardOpen && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cs-wizard-title"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setCsWizardOpen(false)
              setTool('select')
            }
          }}
        >
          <div
            className="modal-dialog"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 id="cs-wizard-title">添加受控源</h3>
            {csWizardErr && <div className="modal-err">{csWizardErr}</div>}
            <label htmlFor="cs-wizard-k">比例系数 k</label>
            <input
              id="cs-wizard-k"
              type="number"
              step="any"
              value={csK}
              onChange={(e) => {
                setCsK(e.target.value)
                setCsWizardErr(null)
              }}
            />
            <fieldset className="cs-fieldset">
              <legend>输出性质</legend>
              <label className="cs-radio">
                <input
                  type="radio"
                  name="csOut"
                  checked={csOutput === 'V'}
                  onChange={() => setCsOutput('V')}
                />
                输出电压（压控/流控电压源）
              </label>
              <label className="cs-radio">
                <input
                  type="radio"
                  name="csOut"
                  checked={csOutput === 'I'}
                  onChange={() => setCsOutput('I')}
                />
                输出电流（压控/流控电流源）
              </label>
            </fieldset>
            <fieldset className="cs-fieldset">
              <legend>控制方式</legend>
              <label className="cs-radio">
                <input
                  type="radio"
                  name="csCtl"
                  checked={csControl === 'volt'}
                  onChange={() => setCsControl('volt')}
                />
                电压控制：参量为 k×(前者电压探针电势 − 后者)
              </label>
              <label className="cs-radio">
                <input
                  type="radio"
                  name="csCtl"
                  checked={csControl === 'curr'}
                  onChange={() => setCsControl('curr')}
                />
                电流控制：参量为 k×(电流探针所测支路电流)
              </label>
            </fieldset>
            {csControl === 'volt' ? (
              <>
                <label htmlFor="cs-vp-plus">电压探针代号（前者，被减数）</label>
                <input
                  id="cs-vp-plus"
                  type="text"
                  maxLength={32}
                  value={csVPlus}
                  onChange={(e) => {
                    setCsVPlus(e.target.value)
                    setCsWizardErr(null)
                  }}
                />
                <label htmlFor="cs-vp-minus">电压探针代号（后者，减数）</label>
                <input
                  id="cs-vp-minus"
                  type="text"
                  maxLength={32}
                  value={csVMinus}
                  onChange={(e) => {
                    setCsVMinus(e.target.value)
                    setCsWizardErr(null)
                  }}
                />
              </>
            ) : (
              <>
                <label htmlFor="cs-iprobe">电流探针代号</label>
                <input
                  id="cs-iprobe"
                  type="text"
                  maxLength={32}
                  value={csIProbe}
                  onChange={(e) => {
                    setCsIProbe(e.target.value)
                    setCsWizardErr(null)
                  }}
                />
              </>
            )}
            <div className="modal-actions">
              <button
                type="button"
                onClick={() => {
                  setCsWizardOpen(false)
                  setTool('select')
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="primary"
                onClick={applyCsWizardModal}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {editCs && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cs-edit-title"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeEditModal()
          }}
        >
          <div
            className="modal-dialog"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 id="cs-edit-title">修改受控源</h3>
            {editCsErr && <div className="modal-err">{editCsErr}</div>}
            <label htmlFor="cs-edit-k">比例系数 k</label>
            <input
              id="cs-edit-k"
              type="number"
              step="any"
              value={editCs.k}
              onChange={(e) =>
                setEditCs((p) => (p ? { ...p, k: e.target.value } : null))
              }
            />
            <fieldset className="cs-fieldset">
              <legend>输出性质</legend>
              <label className="cs-radio">
                <input
                  type="radio"
                  name="csEditOut"
                  checked={editCs.output === 'V'}
                  onChange={() =>
                    setEditCs((p) => (p ? { ...p, output: 'V' } : null))
                  }
                />
                输出电压
              </label>
              <label className="cs-radio">
                <input
                  type="radio"
                  name="csEditOut"
                  checked={editCs.output === 'I'}
                  onChange={() =>
                    setEditCs((p) => (p ? { ...p, output: 'I' } : null))
                  }
                />
                输出电流
              </label>
            </fieldset>
            <fieldset className="cs-fieldset">
              <legend>控制方式</legend>
              <label className="cs-radio">
                <input
                  type="radio"
                  name="csEditCtl"
                  checked={editCs.control === 'volt'}
                  onChange={() =>
                    setEditCs((p) => (p ? { ...p, control: 'volt' } : null))
                  }
                />
                电压控制
              </label>
              <label className="cs-radio">
                <input
                  type="radio"
                  name="csEditCtl"
                  checked={editCs.control === 'curr'}
                  onChange={() =>
                    setEditCs((p) => (p ? { ...p, control: 'curr' } : null))
                  }
                />
                电流控制
              </label>
            </fieldset>
            {editCs.control === 'volt' ? (
              <>
                <label htmlFor="cs-edit-vp-plus">电压探针代号（前者）</label>
                <input
                  id="cs-edit-vp-plus"
                  type="text"
                  maxLength={32}
                  value={editCs.vPlus}
                  onChange={(e) =>
                    setEditCs((p) =>
                      p ? { ...p, vPlus: e.target.value } : null
                    )
                  }
                />
                <label htmlFor="cs-edit-vp-minus">电压探针代号（后者）</label>
                <input
                  id="cs-edit-vp-minus"
                  type="text"
                  maxLength={32}
                  value={editCs.vMinus}
                  onChange={(e) =>
                    setEditCs((p) =>
                      p ? { ...p, vMinus: e.target.value } : null
                    )
                  }
                />
              </>
            ) : (
              <>
                <label htmlFor="cs-edit-iprobe">电流探针代号</label>
                <input
                  id="cs-edit-iprobe"
                  type="text"
                  maxLength={32}
                  value={editCs.iProbe}
                  onChange={(e) =>
                    setEditCs((p) =>
                      p ? { ...p, iProbe: e.target.value } : null
                    )
                  }
                />
              </>
            )}
            <div className="modal-actions">
              <button type="button" onClick={closeEditModal}>
                取消
              </button>
              <button
                type="button"
                className="primary"
                onClick={applyCsEditModal}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {editBranchId && editingBranch && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-param-title"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeEditModal()
          }}
        >
          <div
            className="modal-dialog"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 id="edit-param-title">
              {editingBranch.kind === 'R'
                ? '修改电阻'
                : editingBranch.kind === 'V'
                  ? '修改电压源'
                  : '修改电流源'}
            </h3>
            {modalErr && <div className="modal-err">{modalErr}</div>}
            <label htmlFor="edit-param-input">
              {editingBranch.kind === 'R'
                ? '阻值 R（Ω）'
                : editingBranch.kind === 'V'
                  ? '电压 U（V）'
                  : '电流 Is（A）'}
            </label>
            <input
              id="edit-param-input"
              type="number"
              step="any"
              min={editingBranch.kind === 'R' ? 1e-12 : undefined}
              value={editDraft}
              onChange={(e) => {
                setEditDraft(e.target.value)
                setModalErr(null)
              }}
            />
            <div className="modal-actions">
              <button type="button" onClick={closeEditModal}>
                取消
              </button>
              <button type="button" className="primary" onClick={applyEditModal}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {probeLabelEdit && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="probe-label-title"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeProbeLabelModal()
          }}
        >
          <div
            className="modal-dialog"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 id="probe-label-title">
              {probeLabelEdit.kind === 'current'
                ? '电流探针代号'
                : '电压探针代号'}
            </h3>
            {probeLabelErr && <div className="modal-err">{probeLabelErr}</div>}
            <label htmlFor="probe-label-input">
              代号（与求解后弹窗标题对应；不可与其它电流/电压探针重复）
            </label>
            <input
              id="probe-label-input"
              type="text"
              maxLength={32}
              value={probeLabelDraft}
              onChange={(e) => {
                setProbeLabelDraft(e.target.value)
                setProbeLabelErr(null)
              }}
            />
            <div className="modal-actions">
              <button type="button" onClick={closeProbeLabelModal}>
                取消
              </button>
              <button type="button" className="primary" onClick={applyProbeLabel}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {tabRename && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="tab-rename-title"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeTabRenameModal()
          }}
        >
          <div
            className="modal-dialog"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 id="tab-rename-title">画板名称</h3>
            {tabRenameErr && <div className="modal-err">{tabRenameErr}</div>}
            <label htmlFor="tab-rename-input">显示名称</label>
            <input
              id="tab-rename-input"
              type="text"
              maxLength={48}
              value={tabRenameDraft}
              autoFocus
              onChange={(e) => {
                setTabRenameDraft(e.target.value)
                setTabRenameErr(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  applyTabRename()
                }
              }}
            />
            <div className="modal-actions">
              <button type="button" onClick={closeTabRenameModal}>
                取消
              </button>
              <button type="button" className="primary" onClick={applyTabRename}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {tabCtxMenu && (
        <div
          ref={tabBarCtxMenuRef}
          className="ctx-menu-pop"
          style={{
            position: 'fixed',
            left: Math.min(
              tabCtxMenu.clientX + 4,
              typeof window !== 'undefined'
                ? window.innerWidth - 124
                : tabCtxMenu.clientX
            ),
            top: Math.min(
              tabCtxMenu.clientY + 4,
              typeof window !== 'undefined'
                ? window.innerHeight - 52
                : tabCtxMenu.clientY
            ),
            zIndex: 2002,
          }}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="ctx-menu-action"
            onClick={(e) => {
              e.stopPropagation()
              const t = tabsData.find((x) => x.id === tabCtxMenu.id)
              setTabRename({ id: tabCtxMenu.id })
              setTabRenameDraft(t?.name ?? '')
              setTabRenameErr(null)
              setTabCtxMenu(null)
            }}
          >
            重命名…
          </button>
        </div>
      )}

      {ctxMenu && (
        <div
          ref={ctxMenuRef}
          className="ctx-menu-pop"
          style={{
            position: 'fixed',
            left: Math.min(
              ctxMenu.clientX + 4,
              typeof window !== 'undefined'
                ? window.innerWidth - (ctxMenuTwoButtonStack ? 132 : 116)
                : ctxMenu.clientX
            ),
            top: Math.min(
              ctxMenu.clientY + 4,
              typeof window !== 'undefined'
                ? window.innerHeight - (ctxMenuTwoButtonStack ? 118 : 48)
                : ctxMenu.clientY
            ),
            zIndex: 2001,
          }}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          {ctxMenuTwoButtonStack ? (
            <div className="ctx-menu-stack" role="group">
              <button
                type="button"
                className="ctx-menu-delete"
                onClick={(e) => {
                  e.stopPropagation()
                  if (ctxMenu.kind === 'branch') deleteCtxBranch(ctxMenu.id)
                  else if (ctxMenu.kind === 'vprobe') deleteCtxVoltProbe(ctxMenu.id)
                  else if (ctxMenu.kind === 'probe') deleteCtxProbe(ctxMenu.id)
                }}
              >
                删除
              </button>
              {ctxMenu.kind === 'branch' ? (
                <button
                  type="button"
                  className="ctx-menu-swap"
                  onClick={(e) => {
                    e.stopPropagation()
                    swapCtxDirectedBranch(ctxMenu.id)
                  }}
                >
                  调换
                </button>
              ) : ctxMenu.kind === 'vprobe' || ctxMenu.kind === 'probe' ? (
                <button
                  type="button"
                  className="ctx-menu-swap"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (ctxMenu.kind === 'vprobe') {
                      const vp = voltageProbes.find((v) => v.id === ctxMenu.id)
                      setProbeLabelDraft(vp?.label ?? '')
                      setProbeLabelErr(null)
                      setProbeLabelEdit({ kind: 'volt', id: ctxMenu.id })
                    } else {
                      const cp = probes.find((p) => p.id === ctxMenu.id)
                      setProbeLabelDraft(cp?.label ?? '')
                      setProbeLabelErr(null)
                      setProbeLabelEdit({ kind: 'current', id: ctxMenu.id })
                    }
                    setCtxMenu(null)
                  }}
                >
                  命名
                </button>
              ) : null}
            </div>
          ) : (
            <button
              type="button"
              className="ctx-menu-delete"
              onClick={(e) => {
                e.stopPropagation()
                if (ctxMenu.kind === 'branch') deleteCtxBranch(ctxMenu.id)
                else deleteCtxNode(ctxMenu.nodeId)
              }}
            >
              删除
            </button>
          )}
        </div>
      )}

      <footer className="footer-note">
        本地运行：在项目目录执行 npm install 后执行 npm run dev，浏览器打开提示的地址即可。
      </footer>
    </div>
  )
}
