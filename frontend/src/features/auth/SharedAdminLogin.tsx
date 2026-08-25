import React, { FormEvent, useState } from 'react';
import { Activity, Lock } from 'lucide-react';
import './shared-admin-login.css';

interface SharedAdminLoginProps {
  onLogin: (password: string) => Promise<void>;
}

const SharedAdminLogin: React.FC<SharedAdminLoginProps> = ({ onLogin }) => {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onLogin(password);
      setPassword('');
    } catch (loginError: any) {
      setError(
        loginError?.response?.data?.error
        || loginError?.message
        || 'Accesso non riuscito. Controlla la password e riprova.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="shared-login">
      <section className="shared-login__card" aria-labelledby="shared-login-title">
        <div className="shared-login__brand" aria-hidden="true">
          <Activity size={28} />
        </div>
        <p className="shared-login__eyebrow">FootPredictor personale</p>
        <h1 id="shared-login-title">Accesso condiviso</h1>
        <p className="shared-login__intro">
          Tu e il tuo amico usate lo stesso budget, le stesse giocate e lo stesso archivio.
        </p>

        <form onSubmit={submit} className="shared-login__form">
          <label htmlFor="shared-admin-password">Password condivisa</label>
          <div className="shared-login__field">
            <Lock size={18} aria-hidden="true" />
            <input
              id="shared-admin-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
              autoFocus
            />
          </div>
          {error && <div className="shared-login__error" role="alert">{error}</div>}
          <button type="submit" className="fp-btn fp-btn-green" disabled={submitting || !password}>
            {submitting ? 'Accesso in corso…' : "Entra nell'app"}
          </button>
        </form>
        <p className="shared-login__note">La sessione resta attiva su questo dispositivo.</p>
      </section>
    </main>
  );
};

export default SharedAdminLogin;
