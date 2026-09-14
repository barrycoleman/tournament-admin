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
    <main>
      <h1>{t("settingsRoles.heading")}</h1>
      <form onSubmit={handleSubmit}>
        <div>
          <label htmlFor="settings-role">{t("settingsRoles.roleLabel")}</label>
          <select
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
        <div>
          <label htmlFor="settings-new-password">
            {t("settingsRoles.newPasswordLabel")}
          </label>
          <input
            id="settings-new-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby={mutation.isError ? "settings-roles-error" : undefined}
          />
        </div>
        {mutation.isError && (
          <p id="settings-roles-error" role="alert">
            {mutation.error instanceof ApiError
              ? mutation.error.detail
              : t("settingsRoles.genericError")}
          </p>
        )}
        {mutation.isSuccess && <p role="status">{t("settingsRoles.success")}</p>}
        <button type="submit" disabled={mutation.isPending}>
          {t("settingsRoles.submit")}
        </button>
      </form>
    </main>
  );
}
