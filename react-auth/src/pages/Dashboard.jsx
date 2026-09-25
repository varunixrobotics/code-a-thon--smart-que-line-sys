import { useAuth } from '../context/AuthContext'

export default function Dashboard() {
  const { user, signOut } = useAuth()

  const displayName =
    user?.user_metadata?.full_name ||
    user?.email?.split('@')[0] ||
    'User'

  const initials = displayName
    .split(' ')
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  const handleSignOut = async () => {
    try {
      await signOut()
    } catch (err) {
      console.error('Sign out error:', err)
    }
  }

  return (
    <>
      <div className="auth-bg">
        <div className="orb orb-1" />
        <div className="orb orb-2" />
        <div className="orb orb-3" />
      </div>

      <div className="dashboard-layout">
        <header className="dashboard-nav">
          <div className="nav-brand">
            <div className="nav-brand-icon">🎫</div>
            <span className="nav-brand-text">SmartQueue</span>
          </div>
          <div className="nav-user">
            <span className="nav-email">{user?.email}</span>
            <div className="nav-avatar">{initials}</div>
            <button type="button" className="btn-signout" onClick={handleSignOut}>
              Sign out
            </button>
          </div>
        </header>

        <main className="dashboard-main">
          <div className="welcome-section">
            <p className="welcome-greeting">Welcome back</p>
            <h1 className="welcome-title">Hey, {displayName} 👋</h1>
          </div>

          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-icon purple">🎫</div>
              <div className="stat-value">0</div>
              <div className="stat-label">Active tokens</div>
            </div>
            <div className="stat-card">
              <div className="stat-icon blue">📅</div>
              <div className="stat-value">0</div>
              <div className="stat-label">Appointments</div>
            </div>
            <div className="stat-card">
              <div className="stat-icon green">✅</div>
              <div className="stat-value">0</div>
              <div className="stat-label">Completed</div>
            </div>
          </div>

          <div className="profile-card">
            <h2>Profile</h2>
            <div className="profile-row">
              <span className="profile-label">Name</span>
              <span className="profile-value">{displayName}</span>
            </div>
            <div className="profile-row">
              <span className="profile-label">Email</span>
              <span className="profile-value">{user?.email}</span>
            </div>
            <div className="profile-row">
              <span className="profile-label">Auth provider</span>
              <span className="profile-value">
                {user?.app_metadata?.provider === 'google' ? '🔵 Google' : '📧 Email'}
              </span>
            </div>
            <div className="profile-row">
              <span className="profile-label">User ID</span>
              <span className="profile-value mono">{user?.id}</span>
            </div>
          </div>

          <a className="cta-link" href="http://localhost:3000/app.html">
            🚀 Go to SmartQueue App →
          </a>
        </main>
      </div>
    </>
  )
}
