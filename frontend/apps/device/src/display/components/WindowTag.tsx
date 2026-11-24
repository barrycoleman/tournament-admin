/** The amber tag shown under the clock while a game window is open, naming
 * it with the game plugin's own label. */
export function WindowTag({ label }: { label: string }) {
  return (
    <span className="window-tag" data-testid="window-tag">
      <svg className="window-tag__icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M4 8h14l-4-4M20 16H6l4 4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {label}
    </span>
  );
}
