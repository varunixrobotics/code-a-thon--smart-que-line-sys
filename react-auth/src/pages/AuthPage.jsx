import { useState } from 'react'
import { useAuth } from '../context/AuthContext'

const GOOGLE_SVG = (
  <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
  </svg>
)

function passwordStrength(pw) {
  let score = 0
  if (pw.length >= 10) score++
  if (pw.length >= 14) score++
  if (/[a-z]/.test(pw) && /[A-Z0-9]/.test(pw)) score++
  if (/[^A-Za-z0-9]/.test(pw) || /\s/.test(pw)) score++
  return pw.length < 10 ? Math.min(score, 1) : score
}

const STRENGTH_LABELS = ['Too short', 'Weak', 'Okay', 'Good', 'Strong']

export default function AuthPage() {
  const { signIn, signUp, signInWithGoogle } = useAuth()
  const [tab, setTab] = useState('login')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  // Form fields
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')

  const strength = passwordStrength(password)

  const handleLogin = async (e) => {
    e.preventDefault()
    if (!email || !password) return setError('Enter your email and password.')
    setError('')
    setLoading(true)
    try {
      await signIn(email, password)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleRegister = async (e) => {
    e.preventDefault()
    if (!name || name.trim().length < 2) return setError('Please enter your full name.')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setError('Enter a valid email address.')
    if (password.length < 10) return setError('Password must be at least 10 characters.')
    setError('')
    setLoading(true)
    try {
      await signUp(email, password, name.trim())
      setSuccess('Check your email for a verification link, then sign in!')
      setTab('login')
      setPassword('')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const handleGoogle = async () => {
    setError('')
    try {
      await signInWithGoogle()
    } catch (err) {
      setError(err.message)
    }
  }

  const switchTab = (t) => {
    setTab(t)
    setError('')
    setSuccess('')
  }

  return (
    <>
      {/* Animated Background */}
      <div className="auth-bg">
        <div className="orb orb-1" />
        <div className="orb orb-2" />
        <div className="orb orb-3" />
      </div>

      <div className="auth-layout">
        <div className="auth-container">
          {/* Brand Side */}
          <aside className="auth-brand">
            <div className="brand-logo">
              <div className="brand-icon">🎫</div>
              <span className="brand-name">SmartQueue</span>
            </div>
            <h2 className="brand-tagline">
              Your place in line,<br />
              <span className="highlight">verified.</span>
            </h2>
            <ul className="brand-features">
              <li>
                <span className="feature-icon purple">🔐</span>
                <span>Secure authentication powered by Supabase with email verification and social login.</span>
              </li>
              <li>
                <span className="feature-icon blue">⚡</span>
                <span>Book appointments in seconds. Real-time queue tracking with live position updates.</span>
              </li>
              <li>
                <span className="feature-icon green">📍</span>
                <span>Geofenced check-in verifies you're on-site. No more queue-jumping.</span>
              </li>
            </ul>
            <div className="floating-tokens">
              <div className="mini-token">
                <span className="label">Hospital</span>
                <span className="code">M-042</span>
              </div>
              <div className="mini-token">
                <span className="label">Passport</span>
                <span className="code">P-025</span>
              </div>
              <div className="mini-token">
                <span className="label">Bank</span>
                <span className="code">B-107</span>
              </div>
            </div>
          </aside>

          {/* Form Side */}
          <div className="auth-form-side">
            <h1 className="auth-title">
              {tab === 'login' ? 'Welcome back' : 'Create your account'}
            </h1>
            <p className="auth-subtitle">
              {tab === 'login'
                ? 'Sign in to get and track your queue tokens.'
                : 'Takes a minute. Start booking right away.'}
            </p>

            {/* Tabs */}
            <div className="auth-tabs">
              <button
                type="button"
                className={`tab-btn ${tab === 'login' ? 'active' : ''}`}
                onClick={() => switchTab('login')}
              >
                Sign in
              </button>
              <button
                type="button"
                className={`tab-btn ${tab === 'register' ? 'active' : ''}`}
                onClick={() => switchTab('register')}
              >
                Create account
              </button>
            </div>

            {/* Google */}
            <button type="button" className="google-btn" onClick={handleGoogle}>
              {GOOGLE_SVG}
              Continue with Google
            </button>

            <div className="divider"><span>or continue with email</span></div>

            {/* Alerts */}
            {error && (
              <div className="alert alert-error">
                <span className="alert-icon">⚠️</span>
                <span>{error}</span>
              </div>
            )}
            {success && (
              <div className="alert alert-success">
                <span className="alert-icon">✅</span>
                <span>{success}</span>
              </div>
            )}

            {/* Login Form */}
            {tab === 'login' && (
              <form className="form-stack" onSubmit={handleLogin} noValidate>
                <div className="field">
                  <label htmlFor="login-email">Email</label>
                  <input
                    id="login-email"
                    className="input"
                    type="email"
                    placeholder="name@gmail.com"
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="login-password">Password</label>
                  <div className="password-field">
                    <input
                      id="login-password"
                      className="input"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                    <button
                      type="button"
                      className="password-toggle"
                      onClick={() => setShowPassword(!showPassword)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? '🙈' : '👁️'}
                    </button>
                  </div>
                </div>
                <button className="btn-primary" type="submit" disabled={loading}>
                  {loading ? 'Signing in…' : 'Sign in'}
                </button>
              </form>
            )}

            {/* Register Form */}
            {tab === 'register' && (
              <form className="form-stack" onSubmit={handleRegister} noValidate>
                <div className="field">
                  <label htmlFor="reg-name">Full name</label>
                  <input
                    id="reg-name"
                    className="input"
                    type="text"
                    autoComplete="name"
                    placeholder="Jane Doe"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="reg-email">Email</label>
                  <input
                    id="reg-email"
                    className="input"
                    type="email"
                    placeholder="name@gmail.com"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="reg-password">Password</label>
                  <div className="password-field">
                    <input
                      id="reg-password"
                      className="input"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      placeholder="At least 10 characters"
                      minLength={10}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                    <button
                      type="button"
                      className="password-toggle"
                      onClick={() => setShowPassword(!showPassword)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? '🙈' : '👁️'}
                    </button>
                  </div>
                  <div className="strength-bar" data-level={password ? strength : 0}>
                    <i /><i /><i /><i />
                  </div>
                  <span className="strength-label">
                    {password ? STRENGTH_LABELS[strength] : 'At least 10 characters. A short phrase works well.'}
                  </span>
                </div>
                <button className="btn-primary" type="submit" disabled={loading}>
                  {loading ? 'Creating account…' : 'Create account'}
                </button>
              </form>
            )}

            <p className="auth-footer">
              {tab === 'login' ? (
                <>Don't have an account?{' '}
                  <a href="#" onClick={(e) => { e.preventDefault(); switchTab('register') }}>
                    Sign up free
                  </a>
                </>
              ) : (
                <>Already have an account?{' '}
                  <a href="#" onClick={(e) => { e.preventDefault(); switchTab('login') }}>
                    Sign in
                  </a>
                </>
              )}
            </p>
          </div>
        </div>
      </div>
    </>
  )
}
