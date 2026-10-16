/** Small inline pictures for the period banner: a chip for autonomous, a controller for driver control. */
export function PeriodIcon({ period }: { period: "autonomous" | "driver" }) {
  if (period === "autonomous") {
    return (
      <svg className="period-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="6" y="6" width="12" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" stroke="currentColor" strokeWidth="2" />
      </svg>
    );
  }
  return (
    <svg className="period-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M7 8h10a5 5 0 0 1 4.6 7l-.8 1.8a2.5 2.5 0 0 1-4.3.4L15 15H9l-1.5 2.2a2.5 2.5 0 0 1-4.3-.4L2.4 15A5 5 0 0 1 7 8z"
        fill="currentColor"
      />
    </svg>
  );
}
