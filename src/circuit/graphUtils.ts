import type { Branch } from './types'

export function branchEndpoints(b: Branch): [number, number] {
  if (b.kind === 'R' || b.kind === 'W') return [b.n1, b.n2]
  if (b.kind === 'V' || b.kind === 'CS') return [b.nPlus, b.nMinus]
  return [b.nFrom, b.nTo]
}

/** 将所有出现的节点编号压缩为 0..N-1 */
export function compactCircuit(
  branches: Branch[],
  positionKeys: Iterable<number>,
  groundId: number | null
): {
  branches: Branch[]
  idMap: Map<number, number>
  inverseSize: number
  groundId: number | null
} {
  const ids = new Set<number>()
  for (const k of positionKeys) ids.add(k)
  for (const br of branches) {
    const [a, c] = branchEndpoints(br)
    ids.add(a)
    ids.add(c)
  }
  const sorted = [...ids].sort((a, b) => a - b)
  const idMap = new Map<number, number>()
  sorted.forEach((old, i) => idMap.set(old, i))

  const remap = (x: number) => idMap.get(x) ?? x

  const newBranches: Branch[] = branches.map((b) => {
    if (b.kind === 'R' || b.kind === 'W') {
      return { ...b, n1: remap(b.n1), n2: remap(b.n2) }
    }
    if (b.kind === 'V' || b.kind === 'CS') {
      return {
        ...b,
        nPlus: remap(b.nPlus),
        nMinus: remap(b.nMinus),
      }
    }
    return { ...b, nFrom: remap(b.nFrom), nTo: remap(b.nTo) }
  })

  let newG: number | null = null
  if (groundId !== null && idMap.has(groundId)) {
    newG = remap(groundId)
  }

  return {
    branches: newBranches,
    idMap,
    inverseSize: sorted.length,
    groundId: newG,
  }
}
