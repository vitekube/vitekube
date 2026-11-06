/** `450ms`, `38.2s`, `4m 6s`, `1h 2m 3s`. Rounds first, so 59,999ms reads `1m 0s` and never `60.0s`. */
export const formatDuration = (milliseconds: number): string => {
  if (milliseconds < 999.5) {
    return `${Math.round(milliseconds)}ms`;
  }
  const tenths = Math.round(milliseconds / 100);
  if (tenths < 600) {
    return `${(tenths / 10).toFixed(1)}s`;
  }
  const totalSeconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${minutes}m ${seconds}s`;
};
