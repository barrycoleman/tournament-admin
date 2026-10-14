import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ApiError, useAuth } from "@tournament-admin/shared";
import { safeReturnPath } from "../routeGuards";

export function LoginRoute() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [role, setRole] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      await login(role, password);
      const from = safeReturnPath((location.state as { from?: unknown } | null)?.from);
      navigate(from ?? "/", { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(t("login.invalidCredentials"));
      } else {
        throw err;
      }
    }
  }

  return (
    <main className="auth-screen">
      <div className="auth-card">
        <h1>{t("login.heading")}</h1>
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label className="field__label" htmlFor="role">
              {t("login.roleLabel")}
            </label>
            <input
              className="input"
              id="role"
              name="role"
              value={role}
              onChange={(event) => setRole(event.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="password">
              {t("login.passwordLabel")}
            </label>
            <input
              className="input"
              id="password"
              name="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-describedby={error ? "login-error" : undefined}
            />
          </div>
          {error && (
            <p className="alert alert-danger" id="login-error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button className="btn btn-primary" type="submit">
              {t("login.submit")}
            </button>
          </div>
        </form>
        {/* A plain link, not a router Link: /pair belongs to the device app. */}
        <p className="auth-card__pair">
          <a className="btn" href="/pair">
            {t("login.pairThisDevice")}
          </a>
        </p>
      </div>
    </main>
  );
}
