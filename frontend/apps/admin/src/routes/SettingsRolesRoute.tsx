import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest, ApiError } from "@tournament-admin/shared";

const ROLES = ["admin", "scorer", "judge", "referee", "attendee", "display_device"];

interface RolePasswordRead {
  password: string | null;
}

function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.75" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.75" />
      <path d="M3.5 20.5 20.5 3.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

export function SettingsRolesRoute() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [role, setRole] = useState(ROLES[0]);
  const [password, setPassword] = useState("");
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);

  const currentPasswordQuery = useQuery({
    queryKey: ["rolePassword", role],
    queryFn: () => apiRequest<RolePasswordRead>(`/api/auth/passwords/${role}`),
  });

  const mutation = useMutation({
    mutationFn: () =>
      apiRequest<void>(`/api/auth/passwords/${role}`, {
        method: "PATCH",
        body: { password },
      }),
    onSuccess: () => {
      setPassword("");
      queryClient.invalidateQueries({ queryKey: ["rolePassword", role] });
    },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate();
  }

  const currentPassword = currentPasswordQuery.data?.password ?? null;

  return (
    <div>
      <h1>{t("settingsRoles.heading")}</h1>
      <div className="panel">
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label className="field__label" htmlFor="settings-role">
              {t("settingsRoles.roleLabel")}
            </label>
            <select
              className="select"
              id="settings-role"
              value={role}
              onChange={(event) => {
                setRole(event.target.value);
                setShowCurrentPassword(false);
              }}
            >
              {ROLES.map((roleOption) => (
                <option key={roleOption} value={roleOption}>
                  {roleOption}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="settings-current-password">
              {t("settingsRoles.currentPasswordLabel")}
            </label>
            <div className="form-actions" style={{ marginTop: 0 }}>
              <input
                className="input"
                id="settings-current-password"
                type={showCurrentPassword ? "text" : "password"}
                value={currentPassword ?? ""}
                readOnly
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="icon-btn"
                onClick={() => setShowCurrentPassword((prev) => !prev)}
                disabled={currentPasswordQuery.isLoading || currentPassword === null}
                aria-label={
                  showCurrentPassword
                    ? t("settingsRoles.hidePassword")
                    : t("settingsRoles.showPassword")
                }
                title={
                  showCurrentPassword
                    ? t("settingsRoles.hidePassword")
                    : t("settingsRoles.showPassword")
                }
              >
                {showCurrentPassword ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
            {currentPasswordQuery.isSuccess && currentPassword === null && (
              <p className="field__hint">{t("settingsRoles.noStoredPassword")}</p>
            )}
          </div>
          <div className="field">
            <label className="field__label" htmlFor="settings-new-password">
              {t("settingsRoles.newPasswordLabel")}
            </label>
            <input
              className="input"
              id="settings-new-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-describedby={mutation.isError ? "settings-roles-error" : undefined}
            />
          </div>
          {mutation.isError && (
            <p className="alert alert-danger" id="settings-roles-error" role="alert">
              {mutation.error instanceof ApiError
                ? mutation.error.detail
                : t("settingsRoles.genericError")}
            </p>
          )}
          {mutation.isSuccess && (
            <p className="alert alert-success" role="status">
              {t("settingsRoles.success")}
            </p>
          )}
          <div className="form-actions">
            <button className="btn btn-primary" type="submit" disabled={mutation.isPending}>
              {t("settingsRoles.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
