import './Landing.css'

type LandingProps = {
  onEnter: () => void
}

export default function Landing({ onEnter }: LandingProps) {
  return (
    <div className="landing-root" role="presentation">
      <div className="landing-card">
        <div
          className="landing-avatar-wrap landing-motion-blur landing-stagger--avatar"
        >
          <img
            src="/landing-avatar.png"
            alt=""
            width={196}
            height={196}
            decoding="async"
          />
        </div>
        <h1 className="landing-title landing-motion-blur landing-stagger--title">
          小宋同学の迷你仿真
        </h1>
        <button
          type="button"
          className="landing-enter-btn landing-motion-plain landing-stagger--btn"
          onClick={onEnter}
        >
          进入
        </button>
      </div>
    </div>
  )
}
