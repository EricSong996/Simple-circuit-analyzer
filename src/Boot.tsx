import { useCallback, useState } from 'react'
import App from './App'
import Landing from './Landing'
import LoadingGate from './LoadingGate'

type Phase = 'landing' | 'loading' | 'app'

export default function Boot() {
  const [phase, setPhase] = useState<Phase>('landing')

  const handleLoadingDone = useCallback(() => {
    setPhase('app')
  }, [])

  if (phase === 'app') return <App />
  if (phase === 'loading') return <LoadingGate onComplete={handleLoadingDone} />
  return <Landing onEnter={() => setPhase('loading')} />
}
