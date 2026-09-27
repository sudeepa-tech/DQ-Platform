import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layers, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { PRODUCT_SHORT_NAME, PRODUCT_TAGLINE } from '../config/brand';

const REMEMBER_KEY = 'dq_remembered_email';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState(() => localStorage.getItem(REMEMBER_KEY) || 'admin@example.com');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(() => !!localStorage.getItem(REMEMBER_KEY));
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email, password);
      if (remember) localStorage.setItem(REMEMBER_KEY, email);
      else localStorage.removeItem(REMEMBER_KEY);
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-brand-panel">
        <div className="login-brand-mark">
          <div className="brand-mark" aria-hidden="true"><Layers size={16} strokeWidth={2.2} /></div>
          <div>
            <div className="login-brand-name">{PRODUCT_SHORT_NAME}</div>
            <div className="login-brand-sub">{PRODUCT_TAGLINE}</div>
          </div>
        </div>
        <div className="login-headline">Turn your data into trusted insights.</div>
        <div className="login-tagline">
          Validate, match, and resolve master-data quality issues across your SAP/ERP
          exports — with entity intelligence built for enterprise scale.
        </div>
        <svg className="login-wave" viewBox="0 0 600 180" preserveAspectRatio="none" aria-hidden="true">
          <path fill="#2563eb" fillOpacity="0.12" d="M0,96 C120,140 240,40 360,72 C480,104 540,60 600,84 L600,180 L0,180 Z" />
          <path fill="#2563eb" fillOpacity="0.18" d="M0,120 C130,80 250,150 380,110 C480,80 550,120 600,110 L600,180 L0,180 Z" />
        </svg>
      </div>

      <div className="login-form-panel">
        <div className="login-form-inner">
          <div className="login-form-title">Welcome back</div>
          <div className="login-form-sub">Sign in to continue to your workspace.</div>

          <form onSubmit={handleSubmit}>
            <div className="field">
              <label className="field-label" htmlFor="login-email">Email address</label>
              <input id="login-email" className="input" type="email" autoComplete="username"
                placeholder="you@company.com" value={email} onChange={e => setEmail(e.target.value)} required />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="login-password">Password</label>
              <div style={{ position: 'relative' }}>
                <input id="login-password" className="input" type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password" placeholder="Enter your password"
                  style={{ paddingRight: 40 }} value={password} onChange={e => setPassword(e.target.value)} required />
                <button type="button" className="btn btn-ghost btn-sm" aria-label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowPassword(s => !s)}
                  style={{ position: 'absolute', right: 2, top: 2, padding: 6 }}>
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            <div className="login-remember-row">
              <label>
                <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
                Remember me
              </label>
            </div>

            {error && <div role="alert" className="text-sm mb-4" style={{ color: 'var(--sev-critical)' }}>{error}</div>}

            <button className="btn btn-primary" type="submit" disabled={loading} style={{ width: '100%', justifyContent: 'center' }}>
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
          </form>

          <p className="login-footnote">
            First run? Check the server console for the auto-generated administrator password, or set
            SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD before first start.
          </p>
        </div>
      </div>
    </div>
  );
}
