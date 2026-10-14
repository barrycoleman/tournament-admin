import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { normalizeCode } from "./format";
import { PAIRABLE_ROLES, checkPairingCode, useDeviceMutations, type PairingCodeCheck } from "./useDevices";

const CODE_LENGTH = 6;

export function PairDeviceForm({ initialCode = "" }: { initialCode?: string }) {
  const { t } = useTranslation();
  const { pair } = useDeviceMutations();
  const [code, setCode] = useState(initialCode);
  const [role, setRole] = useState<string>("scorer");
  const [name, setName] = useState("");
  const [checked, setChecked] = useState<PairingCodeCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [pairedName, setPairedName] = useState<string | null>(null);
  // The last name the server suggested: replaced by the next suggestion,
  // unlike a name the admin typed themselves.
  const lastSuggestion = useRef("");

  const normalized = normalizeCode(code);

  useEffect(() => {
    setChecked(null);
    setCodeError(null);
    if (normalized.length !== CODE_LENGTH) {
      setChecking(false);
      return undefined;
    }
    let cancelled = false;
    setChecking(true);
    checkPairingCode(normalized)
      .then((result) => {
        if (cancelled) return;
        setChecked(result);
        setName((current) => (current === "" || current === lastSuggestion.current ? result.suggested_name : current));
        lastSuggestion.current = result.suggested_name;
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) setCodeError(t("devices.unknownCode"));
        else setCodeError(apiErrorMessage(error, t("errors.generic")));
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [normalized, t]);

  function pairErrorMessage(error: unknown): string {
    if (error instanceof ApiError && error.status === 404) return t("devices.unknownCode");
    if (error instanceof ApiError && error.status === 409) return t("devices.duplicateName");
    return apiErrorMessage(error, t("errors.generic"));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPairedName(null);
    const device = await pair.mutateAsync({ code: normalized, role, name }).catch(() => null);
    if (!device) return;
    setPairedName(device.name);
    setCode("");
    setName("");
    lastSuggestion.current = "";
  }

  return (
    <form className="panel" onSubmit={handleSubmit} aria-labelledby="pair-heading">
      <h2 id="pair-heading">{t("devices.pairHeading")}</h2>
      <p className="field__hint">{t("devices.pairHelp")}</p>
      <div className="field">
        <label className="field__label" htmlFor="pair-code">
          {t("devices.codeLabel")}
        </label>
        <input
          className="input"
          id="pair-code"
          value={code}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          onChange={(event) => setCode(event.target.value)}
          aria-invalid={codeError ? true : undefined}
          aria-describedby={codeError ? "pair-code-error" : undefined}
        />
        {checking && <p className="field__hint">{t("devices.checking")}</p>}
        {codeError && (
          <p className="alert alert-danger" id="pair-code-error" role="alert">
            {codeError}
          </p>
        )}
      </div>
      <div className="field">
        <label className="field__label" htmlFor="pair-role">
          {t("devices.roleLabel")}
        </label>
        <select className="input" id="pair-role" value={role} onChange={(event) => setRole(event.target.value)}>
          {PAIRABLE_ROLES.map((r) => (
            <option key={r} value={r}>
              {t(`devices.roles.${r}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="pair-name">
          {t("devices.nameLabel")}
        </label>
        <input
          className="input"
          id="pair-name"
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      {pair.isError && (
        <p className="alert alert-danger" role="alert">
          {pairErrorMessage(pair.error)}
        </p>
      )}
      {pairedName && (
        <p className="alert alert-success" role="status">
          {t("devices.paired", { name: pairedName })}
        </p>
      )}
      <div className="form-actions">
        <button className="btn btn-primary" type="submit" disabled={!checked || !name.trim() || pair.isPending}>
          {t("devices.pair")}
        </button>
      </div>
    </form>
  );
}
