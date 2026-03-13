export function computeP95(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[index]!;
}

export function collectMeasuredProcessingDurations(
  rows: Array<{ processing_duration_ms: number | null }>,
): number[] {
  return rows
    .map((row) => row.processing_duration_ms)
    .filter((value): value is number => Number.isFinite(value) && value !== null && value >= 0);
}
