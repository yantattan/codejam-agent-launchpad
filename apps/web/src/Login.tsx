import { useState } from "react";
import { supabase, supabaseConfigured } from "./supabaseClient";

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export default function Login() {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!supabaseConfigured || !supabase) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Sign-in is not configured</h1>
          <p>
            Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in
            the project's <code>.env</code>, then restart the dev server.
          </p>
        </section>
      </main>
    );
  }
  const client = supabase;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "sign-in") {
        const { error: signInError } = await client.auth.signInWithPassword({
          email,
          password,
        });
        if (signInError) throw signInError;
      } else {
        const { error: signUpError } = await client.auth.signUp({ email, password });
        if (signUpError) throw signUpError;
        setNotice("Account created. Check your email to confirm it, then sign in.");
        setMode("sign-in");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand-mark">A</div>
        <span className="eyebrow">Agent Launchpad</span>
        <h1>{mode === "sign-in" ? "Sign in" : "Create your account"}</h1>
        <p>Each account only sees the Agents it created.</p>

        {error && <div className="error-banner" role="alert">{error}</div>}
        {notice && <div className="notice-banner" role="status">{notice}</div>}

        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={6}
            required
          />
        </label>

        <button className="button button-primary" disabled={busy}>
          {busy ? <Spinner /> : mode === "sign-in" ? "Sign in" : "Sign up"}
        </button>

        <button
          type="button"
          className="auth-switch"
          onClick={() => {
            setMode((current) => (current === "sign-in" ? "sign-up" : "sign-in"));
            setError(null);
            setNotice(null);
          }}
        >
          {mode === "sign-in" ? "Need an account? Sign up" : "Already have an account? Sign in"}
        </button>
      </form>
    </main>
  );
}
