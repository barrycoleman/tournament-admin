import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../components/Modal";
import type { GamePluginChangePreview } from "../types";

interface GamePluginChangeDialogProps {
  /** The plugin being switched to, or null when the selection is being cleared. */
  target: { name: string; displayName: string } | null;
  preview: GamePluginChangePreview;
  isPending: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function GamePluginChangeDialog({
  target,
  preview,
  isPending,
  error,
  onConfirm,
  onCancel,
}: GamePluginChangeDialogProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const { would_reset: reset, awards_needing_attention: awards } = preview;
  const nothingToReset =
    !reset.skills_enabled && reset.session_attempt_overrides === 0 && !reset.ranking_settings;

  return (
    <Modal
      labelledBy={headingId}
      onCancel={() => {
        if (!isPending) onCancel();
      }}
    >
      <h2 id={headingId}>
        {target
          ? t("eventSetup.switchHeading", { name: target.displayName })
          : t("eventSetup.clearHeading")}
      </h2>
      <p>{t("eventSetup.resetIntro")}</p>
      <ul>
        {reset.skills_enabled && <li>{t("eventSetup.resetSkills")}</li>}
        {reset.session_attempt_overrides > 0 && (
          <li>{t("eventSetup.resetOverrides", { count: reset.session_attempt_overrides })}</li>
        )}
        {reset.ranking_settings && <li>{t("eventSetup.resetRanking")}</li>}
        {nothingToReset && <li>{t("eventSetup.resetNothing")}</li>}
      </ul>
      {awards.length > 0 && (
        <>
          <p>{t("eventSetup.awardsIntro")}</p>
          <ul>
            {awards.map((award) => (
              <li key={award.award_id}>
                {t("eventSetup.awardItem", { session: award.session_label, name: award.name })}
              </li>
            ))}
          </ul>
        </>
      )}
      {error && (
        <p className="alert alert-danger" role="alert">
          {error}
        </p>
      )}
      <div className="dialog__actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={onConfirm}
          disabled={isPending}
        >
          {target ? t("eventSetup.switchConfirm") : t("eventSetup.clearConfirm")}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={isPending} data-autofocus>
          {t("eventSetup.cancel")}
        </button>
      </div>
    </Modal>
  );
}
