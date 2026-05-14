import { useEffect, useMemo, useRef, useState } from 'react'
import './LoadingGate.css'

type Knot = { t: number; p: number }

/** 生成随机时间节点，单调时间与进度；总时长约 totalMs，终点为 100% */
function buildRandomProgressKnots(totalMs: number): Knot[] {
  const knots: Knot[] = [{ t: 0, p: 0 }]
  let t = 0
  let p = 0
  const minTail = 90

  while (p < 99.2 && t < totalMs - minTail) {
    const dt = 55 + Math.random() * 380
    const dp = 1.8 + Math.random() * 16
    t += dt
    p = Math.min(99.3, p + dp)
    if (t >= totalMs - minTail) break
    const prev = knots[knots.length - 1]
    if (t <= prev.t + 12) t = prev.t + 12
    if (p <= prev.p + 0.05) p = prev.p + 0.4
    knots.push({ t, p: Math.round(p * 100) / 100 })
  }

  knots.push({ t: totalMs, p: 100 })

  for (let i = 1; i < knots.length; i++) {
    if (knots[i].t <= knots[i - 1].t) {
      knots[i].t = knots[i - 1].t + 8
    }
    if (knots[i].p < knots[i - 1].p) {
      knots[i].p = knots[i - 1].p
    }
  }
  knots[knots.length - 1].t = totalMs
  knots[knots.length - 1].p = 100
  return knots
}

function progressAt(elapsedMs: number, knots: Knot[]): number {
  if (elapsedMs <= 0) return 0
  const last = knots[knots.length - 1]
  if (elapsedMs >= last.t) return 100
  let i = 1
  while (i < knots.length && knots[i].t < elapsedMs) i += 1
  const a = knots[i - 1]
  const b = knots[i]
  const u = (elapsedMs - a.t) / (b.t - a.t || 1)
  return a.p + u * (b.p - a.p)
}

const END_PAUSE_MS = 280

type LoadingGateProps = {
  onComplete: () => void
}

export default function LoadingGate({ onComplete }: LoadingGateProps) {
  const [fillPct, setFillPct] = useState(0)
  const endTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const completedRef = useRef(false)

  const totalMs = useMemo(() => 2850 + Math.floor(Math.random() * 320), [])

  const knots = useMemo(
    () => buildRandomProgressKnots(totalMs),
    [totalMs]
  )

  useEffect(() => {
    completedRef.current = false
    const start = performance.now()
    const rafRef = { id: 0 }

    const tick = (now: number) => {
      const elapsed = now - start
      const p = progressAt(elapsed, knots)
      setFillPct(p)

      if (p >= 99.999 && !completedRef.current) {
        completedRef.current = true
        setFillPct(100)
        endTimerRef.current = setTimeout(() => {
          onComplete()
        }, END_PAUSE_MS)
        return
      }

      if (!completedRef.current) {
        rafRef.id = requestAnimationFrame(tick)
      }
    }

    rafRef.id = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(rafRef.id)
      if (endTimerRef.current !== null) {
        clearTimeout(endTimerRef.current)
        endTimerRef.current = null
      }
    }
  }, [knots, onComplete])

  return (
    <div className="loading-gate" role="status" aria-live="polite">
      <div className="loading-gate-inner">
        <div className="loading-gate-heading">
          <span className="loading-gate-label">Loading</span>
          <span className="loading-gate-dots" aria-hidden>
            <span className="loading-gate-dot loading-gate-dot--1" />
            <span className="loading-gate-dot loading-gate-dot--2" />
            <span className="loading-gate-dot loading-gate-dot--3" />
            <span className="loading-gate-dot loading-gate-dot--4" />
          </span>
        </div>
        <div className="loading-gate-track">
          <div
            className="loading-gate-fill"
            style={{ width: `${fillPct}%` }}
          />
        </div>
      </div>
    </div>
  )
}
