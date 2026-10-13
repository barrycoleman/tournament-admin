/** "512 B", "2 KB", "1.5 MB": one decimal place at most, dropped when zero. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const round = (n: number) => String(Math.round(n * 10) / 10);
  if (bytes < 1024 * 1024) return `${round(bytes / 1024)} KB`;
  return `${round(bytes / (1024 * 1024))} MB`;
}

export function reasonKey(reason: string): string {
  return `backups.reasons.${reason}`;
}
