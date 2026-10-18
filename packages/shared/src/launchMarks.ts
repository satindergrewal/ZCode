/** Four startup instants captured in main (epoch millis); the renderer derives phase durations. */
export interface LaunchMarks {
  /// process.getCreationTime(): process created (anchor T0)
  createdAt: number;
  /// Date.now() at the top of main/index.ts (T1)
  mainStart: number;
  /// Date.now() at app.whenReady callback entry (T2)
  appReady: number;
  /// Date.now() in the main window's loadWindow before loadURL (T3)
  loadUrl: number;
}

/** Query-string parameter carrying launch marks in the main window's loadURL */
export const LAUNCH_MARKS_QUERY_KEY = "zcodeLaunchMarks";

export function serializeLaunchMarks(marks: LaunchMarks): string {
  return JSON.stringify(marks);
}

export function parseLaunchMarks(raw: string | null | undefined): LaunchMarks | null {
  if (raw == null || raw === "") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const keys: (keyof LaunchMarks)[] = ["createdAt", "mainStart", "appReady", "loadUrl"];
  const result = {} as LaunchMarks;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    result[key] = value;
  }
  return result;
}
