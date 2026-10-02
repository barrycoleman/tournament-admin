import { useId } from "react";
import { useTranslation } from "react-i18next";
import { formatCycleTime, projectedFinish } from "./scheduleRequest";
import type { ScheduleGenerateResponse } from "../types";

export function PreviewPanel({ response, stale }: { response: ScheduleGenerateResponse; stale: boolean }) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section className="panel" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("sessions.schedule.preview.heading")}</h2>
      {stale && (
        <p className="alert alert-warning" role="status">
          {t("sessions.schedule.preview.stale")}
        </p>
      )}
      {response.cycle_time_warning && <p className="alert alert-warning">{response.cycle_time_warning}</p>}
      <ul className="list-plain">
        {(response.phase_results ?? []).map((phase) => (
          <li key={phase.round_type} className="list-row">
            {t("sessions.schedule.preview.phaseLine", { round: phase.round_type, count: phase.match_count })}
          </li>
        ))}
      </ul>
      <table className="schedule-table">
        <thead>
          <tr>
            <th>{t("sessions.schedule.preview.columnDate")}</th>
            <th>{t("sessions.schedule.preview.columnStart")}</th>
            <th>{t("sessions.schedule.preview.columnEnd")}</th>
            <th>{t("sessions.schedule.preview.columnCycle")}</th>
            <th>{t("sessions.schedule.preview.columnSlots")}</th>
          </tr>
        </thead>
        <tbody>
          {response.resolved_time_blocks.map((block, index) => {
            let end = block.end_time;
            if (end === null) {
              const finish = projectedFinish(block);
              end =
                t("sessions.schedule.preview.projectedFinish", { time: finish.time }) +
                (finish.dayOffset > 0 ? t("sessions.schedule.preview.nextDay", { count: finish.dayOffset }) : "");
            }
            return (
              <tr key={index}>
                <td>{block.date}</td>
                <td>{block.start_time}</td>
                <td>{end}</td>
                <td>{formatCycleTime(block.cycle_time_seconds)}</td>
                <td>{block.time_slot_count}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
