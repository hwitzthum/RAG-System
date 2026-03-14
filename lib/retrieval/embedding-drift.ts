import type { SupportedLanguage } from "@/lib/contracts/retrieval";

export type EmbeddingSample = {
  embedding: number[];
  language: SupportedLanguage | null;
};

export type EmbeddingLanguageSnapshot = {
  count: number;
  normMean: number;
  normStdDev: number;
  centroid: number[];
};

export type EmbeddingSnapshot = {
  sampleCount: number;
  dimension: number;
  zeroVectorCount: number;
  nearZeroVectorCount: number;
  normMean: number;
  normStdDev: number;
  normP95: number;
  centroid: number[];
  languageStats: Partial<Record<SupportedLanguage, EmbeddingLanguageSnapshot>>;
};

export type EmbeddingDriftThresholds = {
  minSamples: number;
  minLanguageSamples: number;
  maxZeroVectorRate: number;
  maxNearZeroVectorRate: number;
  maxNormMeanDeltaRatio: number;
  maxNormStdDevDeltaRatio: number;
  maxCentroidCosineDistance: number;
  maxLanguageCentroidCosineDistance: number;
};

export type EmbeddingDriftCheck = {
  name: string;
  passed: boolean;
  detail: string;
};

export type EmbeddingDriftEvaluation = {
  passed: boolean;
  checks: EmbeddingDriftCheck[];
};

export const DEFAULT_EMBEDDING_DRIFT_THRESHOLDS: EmbeddingDriftThresholds = {
  minSamples: 100,
  minLanguageSamples: 25,
  maxZeroVectorRate: 0,
  maxNearZeroVectorRate: 0.01,
  maxNormMeanDeltaRatio: 0.15,
  maxNormStdDevDeltaRatio: 0.25,
  maxCentroidCosineDistance: 0.08,
  maxLanguageCentroidCosineDistance: 0.12,
};

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[], average: number): number {
  if (values.length === 0) {
    return 0;
  }
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * quantile)));
  return sorted[index] ?? 0;
}

function vectorNorm(embedding: number[]): number {
  return Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0));
}

function averageVectors(vectors: number[][], dimension: number): number[] {
  if (vectors.length === 0) {
    return new Array<number>(dimension).fill(0);
  }

  const centroid = new Array<number>(dimension).fill(0);
  for (const vector of vectors) {
    for (let index = 0; index < dimension; index += 1) {
      centroid[index] = (centroid[index] ?? 0) + (vector[index] ?? 0);
    }
  }

  for (let index = 0; index < dimension; index += 1) {
    centroid[index] = (centroid[index] ?? 0) / vectors.length;
  }

  return centroid;
}

export function cosineDistance(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 1;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 1;
  }

  const similarity = dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
  return 1 - similarity;
}

function computeLanguageSnapshot(samples: EmbeddingSample[], dimension: number): EmbeddingLanguageSnapshot {
  const norms = samples.map((sample) => vectorNorm(sample.embedding));
  const normMean = mean(norms);
  return {
    count: samples.length,
    normMean,
    normStdDev: standardDeviation(norms, normMean),
    centroid: averageVectors(samples.map((sample) => sample.embedding), dimension),
  };
}

export function computeEmbeddingSnapshot(samples: EmbeddingSample[]): EmbeddingSnapshot {
  if (samples.length === 0) {
    return {
      sampleCount: 0,
      dimension: 0,
      zeroVectorCount: 0,
      nearZeroVectorCount: 0,
      normMean: 0,
      normStdDev: 0,
      normP95: 0,
      centroid: [],
      languageStats: {},
    };
  }

  const dimension = samples[0]?.embedding.length ?? 0;
  if (dimension === 0) {
    throw new Error("Embedding samples must have a non-zero dimension");
  }

  for (const sample of samples) {
    if (sample.embedding.length !== dimension) {
      throw new Error(`Embedding dimension mismatch in sample set: expected ${dimension}, got ${sample.embedding.length}`);
    }
  }

  const norms = samples.map((sample) => vectorNorm(sample.embedding));
  const normMean = mean(norms);
  const languageStats: Partial<Record<SupportedLanguage, EmbeddingLanguageSnapshot>> = {};

  for (const language of ["EN", "DE", "FR", "IT", "ES"] as SupportedLanguage[]) {
    const languageSamples = samples.filter((sample) => sample.language === language);
    if (languageSamples.length === 0) {
      continue;
    }
    languageStats[language] = computeLanguageSnapshot(languageSamples, dimension);
  }

  return {
    sampleCount: samples.length,
    dimension,
    zeroVectorCount: norms.filter((norm) => norm === 0).length,
    nearZeroVectorCount: norms.filter((norm) => norm < 1e-6).length,
    normMean,
    normStdDev: standardDeviation(norms, normMean),
    normP95: percentile(norms, 0.95),
    centroid: averageVectors(samples.map((sample) => sample.embedding), dimension),
    languageStats,
  };
}

function ratioDelta(current: number, baseline: number): number {
  if (baseline === 0) {
    return current === 0 ? 0 : 1;
  }
  return Math.abs(current - baseline) / baseline;
}

export function evaluateEmbeddingDrift(input: {
  current: EmbeddingSnapshot;
  baseline: EmbeddingSnapshot | null;
  thresholds?: Partial<EmbeddingDriftThresholds>;
}): EmbeddingDriftEvaluation {
  const thresholds = { ...DEFAULT_EMBEDDING_DRIFT_THRESHOLDS, ...input.thresholds };
  const current = input.current;
  const baseline = input.baseline;

  const checks: EmbeddingDriftCheck[] = [
    {
      name: "sample_size_sufficient",
      passed: current.sampleCount >= thresholds.minSamples,
      detail: `sample_count=${current.sampleCount}, min_samples=${thresholds.minSamples}`,
    },
    {
      name: "zero_vectors_absent",
      passed: current.sampleCount === 0 ? true : current.zeroVectorCount / current.sampleCount <= thresholds.maxZeroVectorRate,
      detail: `zero_vector_rate=${current.sampleCount === 0 ? 0 : current.zeroVectorCount / current.sampleCount}, threshold=${thresholds.maxZeroVectorRate}`,
    },
    {
      name: "near_zero_vectors_within_limit",
      passed: current.sampleCount === 0 ? true : current.nearZeroVectorCount / current.sampleCount <= thresholds.maxNearZeroVectorRate,
      detail: `near_zero_vector_rate=${current.sampleCount === 0 ? 0 : current.nearZeroVectorCount / current.sampleCount}, threshold=${thresholds.maxNearZeroVectorRate}`,
    },
  ];

  if (!baseline || baseline.sampleCount === 0) {
    checks.push({
      name: "baseline_present",
      passed: true,
      detail: "No prior baseline present; current snapshot should be adopted as baseline.",
    });
    return {
      passed: checks.every((check) => check.passed),
      checks,
    };
  }

  const centroidDistance = cosineDistance(current.centroid, baseline.centroid);
  checks.push(
    {
      name: "embedding_dimension_consistent",
      passed: current.dimension === baseline.dimension,
      detail: `current_dimension=${current.dimension}, baseline_dimension=${baseline.dimension}`,
    },
    {
      name: "norm_mean_drift_within_limit",
      passed: ratioDelta(current.normMean, baseline.normMean) <= thresholds.maxNormMeanDeltaRatio,
      detail: `current=${current.normMean.toFixed(6)}, baseline=${baseline.normMean.toFixed(6)}, max_ratio_delta=${thresholds.maxNormMeanDeltaRatio}`,
    },
    {
      name: "norm_stddev_drift_within_limit",
      passed: ratioDelta(current.normStdDev, baseline.normStdDev) <= thresholds.maxNormStdDevDeltaRatio,
      detail: `current=${current.normStdDev.toFixed(6)}, baseline=${baseline.normStdDev.toFixed(6)}, max_ratio_delta=${thresholds.maxNormStdDevDeltaRatio}`,
    },
    {
      name: "centroid_drift_within_limit",
      passed: centroidDistance <= thresholds.maxCentroidCosineDistance,
      detail: `cosine_distance=${centroidDistance.toFixed(6)}, threshold=${thresholds.maxCentroidCosineDistance}`,
    },
  );

  for (const language of ["EN", "DE", "FR", "IT", "ES"] as SupportedLanguage[]) {
    const currentLanguage = current.languageStats[language];
    const baselineLanguage = baseline.languageStats[language];
    if (!currentLanguage || !baselineLanguage) {
      continue;
    }
    if (currentLanguage.count < thresholds.minLanguageSamples || baselineLanguage.count < thresholds.minLanguageSamples) {
      continue;
    }

    const distance = cosineDistance(currentLanguage.centroid, baselineLanguage.centroid);
    checks.push({
      name: `language_${language.toLowerCase()}_centroid_drift_within_limit`,
      passed: distance <= thresholds.maxLanguageCentroidCosineDistance,
      detail: `language=${language}, cosine_distance=${distance.toFixed(6)}, threshold=${thresholds.maxLanguageCentroidCosineDistance}`,
    });
  }

  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
}
