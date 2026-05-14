export type BranchKind = 'R' | 'V' | 'I' | 'W' | 'CS'

export interface BranchR {
  id: string
  kind: 'R'
  n1: number
  n2: number
  ohms: number
}

export interface BranchV {
  id: string
  kind: 'V'
  /** 正极 */
  nPlus: number
  /** 负极 */
  nMinus: number
  volts: number
}

/** 独立恒流源：电流从 nFrom 经电源内部流向 nTo（单位 A） */
export interface BranchI {
  id: string
  kind: 'I'
  nFrom: number
  nTo: number
  amps: number
}

/**
 * 导线：两端为独立节点，图上保留连线；求解时等效为 0V 电压源（约束两端等电位）。
 */
export interface BranchW {
  id: string
  kind: 'W'
  n1: number
  n2: number
}

/** 输出为电压源时与 BranchV 相同端子语义；为电流源时 nPlus/nMinus 即 nFrom/nTo（内部电流从 nPlus→nMinus） */
export type CsOutput = 'V' | 'I'
/** 电压控制：参量 k×(U_vp+−U_vp−)；电流控制：参量 k×I_探针支路 */
export type CsControl = 'volt' | 'curr'

export interface BranchCS {
  id: string
  kind: 'CS'
  output: CsOutput
  control: CsControl
  nPlus: number
  nMinus: number
  k: number
  /** 电压控制时有效：两电压探针代号（trim 比较） */
  vProbeLabelPlus: string
  vProbeLabelMinus: string
  /** 电流控制时有效：电流探针代号 */
  iProbeLabel: string
}

export type Branch = BranchR | BranchV | BranchI | BranchW | BranchCS

/** 电流探针：吸附在某条支路上，显示该支路电流（不参与方程） */
export interface CurrentProbe {
  id: string
  targetBranchId: string
  x: number
  y: number
  /** 探针代号（全局唯一，去空格比较）；新放置时自动分配 P1、P2…，可右键改名 */
  label: string
}

/** 电压探针：绑定节点，显示相对接地的电势（不参与方程） */
export interface VoltageProbe {
  id: string
  /** 所测节点编号（与 positions / 求解结果索引一致） */
  nodeId: number
  x: number
  y: number
  /** 探针代号（全局唯一，去空格比较）；新放置时自动分配 P1、P2…，可右键改名 */
  label: string
}

export interface SolveOk {
  ok: true
  /** 节点电压，索引为节点编号，单位 V */
  nodeV: number[]
  /** 与 branches 同序：电阻为 n1→n2；电压源/受控电压输出为 + 经源内部→−；导线为 n1→n2；电流源/受控电流输出为 nPlus→nMinus */
  branchCurrents: number[]
}

export interface SolveErr {
  ok: false
  message: string
}

export type SolveResult = SolveOk | SolveErr
