"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setNotice("");
    const supabase = createClient();
    const normalizedEmail = email.trim();

    if (mode === "signup") {
      if (password.length < 8) {
        setLoading(false);
        setError("La contraseña debe tener al menos 8 caracteres.");
        return;
      }
      if (password !== passwordConfirmation) {
        setLoading(false);
        setError("Las contraseñas no coinciden.");
        return;
      }

      const { data, error: signUpError } = await supabase.auth.signUp({
        email: normalizedEmail,
        password,
        options: {
          emailRedirectTo: new URL("/auth/callback", window.location.origin).toString(),
        },
      });
      setLoading(false);
      if (signUpError) {
        const message = signUpError.message || "";
        setError(/sign.?up.*(disabled|not allowed)|signup is disabled/i.test(message)
          ? "El registro está desactivado en Supabase. Habilitá los registros por email para permitir nuevas cuentas."
          : "No se pudo crear la cuenta. Revisá los datos e intentá otra vez.");
        return;
      }
      if (data.session) {
        router.push("/");
        router.refresh();
        return;
      }
      setNotice("Te enviamos un correo para confirmar la cuenta. Después vas a poder iniciar sesión.");
      return;
    }

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    });
    setLoading(false);
    if (signInError) {
      setError("Email o contraseña incorrectos.");
      return;
    }
    router.push("/");
    router.refresh();
  }

  function changeMode(nextMode) {
    setMode(nextMode);
    setError("");
    setNotice("");
    setPassword("");
    setPasswordConfirmation("");
  }

  const creatingAccount = mode === "signup";

  return (
    <div className="et-app">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
      `}</style>
      <div className="et-login-wrap">
        <div className="et-login-card">
          <div className="et-login-title">Panel de Gastos</div>
          <div className="et-login-sub">
            {creatingAccount ? "Creá tu cuenta para empezar." : "Iniciá sesión para ver tus movimientos."}
          </div>
          <form onSubmit={handleSubmit}>
            <div className="et-field">
              <label className="et-label" htmlFor="login-email">Email</label>
              <input
                id="login-email"
                className="et-input"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </div>
            <div className="et-field">
              <label className="et-label" htmlFor="login-password">Contraseña</label>
              <input
                id="login-password"
                className="et-input"
                type="password"
                required
                minLength={creatingAccount ? 8 : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={creatingAccount ? "new-password" : "current-password"}
              />
            </div>
            {creatingAccount && (
              <div className="et-field">
                <label className="et-label" htmlFor="confirm-password">Repetir contraseña</label>
                <input
                  id="confirm-password"
                  className="et-input"
                  type="password"
                  required
                  minLength={8}
                  value={passwordConfirmation}
                  onChange={(e) => setPasswordConfirmation(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
            )}
            {error && <div className="et-login-error" role="alert">{error}</div>}
            {notice && <div className="et-login-notice" role="status">{notice}</div>}
            <button className="et-save-btn" type="submit" disabled={loading}>
              {loading
                ? (creatingAccount ? "Creando cuenta…" : "Ingresando…")
                : (creatingAccount ? "Crear cuenta" : "Ingresar")}
            </button>
          </form>
          <div className="et-login-switch">
            {creatingAccount ? "¿Ya tenés cuenta?" : "¿Primera vez?"}
            <button
              type="button"
              className="et-login-switch-btn"
              onClick={() => changeMode(creatingAccount ? "login" : "signup")}
            >
              {creatingAccount ? "Iniciá sesión" : "Crear cuenta"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
