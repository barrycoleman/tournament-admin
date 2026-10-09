import { apiRequest } from "@tournament-admin/shared";

/** Fetches the ceremony CSV with the bearer token and saves it. */
export async function downloadAwardsCsv(sessionId: number): Promise<void> {
  const text = await apiRequest<string>(`/api/sessions/${sessionId}/awards.csv`, { responseType: "text" });
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `awards-${sessionId}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
