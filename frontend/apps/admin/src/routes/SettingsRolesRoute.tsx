import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest, ApiError } from "@tournament-admin/shared";

const ROLES = ["admin", "scorer", "judge", "referee", "attendee", "display_device"];

export function SettingsRolesRoute() {
  const { t } = useTranslation();
  const [role, setRole] = useState(ROLES[0]);
  const [password, setPassword] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      apiRequest<void>(`/api/auth/passwords/${role}`, {
        method: "PATCH",
        body: { password },
      }),
    onSuccess: () => setPassword(""),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    mutation.mutate();
  }

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
              onChange={(event) => setRole(event.target.value)}
            >
              {ROLES.map((roleOption) => (
                <option key={roleOption} value={roleOption}>
                  {roleOption}
                </option>
              ))}
            </select>
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
