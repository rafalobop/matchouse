// BE-05: compara el reporte de evals de un PR contra el baseline commiteado en la rama base, y
// falla (exit code 1) si algún campo de calidad retrocede más que el umbral — el "eval gate" que
// consume .github/workflows/eval-gate.yml. Vive separado de run.ts/compare-models.ts porque esto
// es pura comparación de dos reportes ya generados, sin llamar a ningún proveedor de IA.
import * as fs from 'fs';

interface OperationReport {
  operation: string;
  totalCases: number;
  executedCases: number;
  executionErrors: { id: string; error: string }[];
  criticalFailure: boolean;
  latency: { p50: number; p95: number; meanMs: number };
  metrics: Record<string, number>;
}

interface EvalReportFile {
  date: string;
  reports: OperationReport[];
}

// Métricas de fracción 0-1 donde un valor MÁS ALTO es mejor calidad (accuracy/precision/recall).
const HIGHER_IS_BETTER = new Set([
  'operationMatchRate', 'propertyTypeMatchRate', 'currencyMatchRate', 'countryMatchRate', 'bedroomsMinMatchRate',
  'locationMentionsPrecision', 'locationMentionsRecall', 'featuresPrecision', 'featuresRecall',
  'segmentCountMatchRate', 'segmentExactMatchRate',
  'fieldAccuracy'
]);

// Métricas de fracción 0-1 donde un valor MÁS BAJO es mejor calidad (tasas de error/"no supo responder").
const LOWER_IS_BETTER = new Set(['budgetNullMismatchRate', 'desconocidaRate', 'falseDesconocidaRate']);

// budgetMeanAbsError es un valor absoluto (USD/unidades), no una fracción 0-1 — comparar contra un
// umbral en "puntos porcentuales" no tiene sentido acá. Se muestra siempre, nunca gatea el pass/fail.
const INFORMATIONAL_ONLY = new Set(['budgetMeanAbsError']);

// BE-09: antes 'zone' necesitaba una conexión real a Supabase (sin ella, el eval gate de CI
// mostraría una "regresión" falsa) — con la extracción fusionada, las métricas de `search-intent`
// (ver evals/metrics.ts) solo miran el output CRUDO del LLM (`location_mentions`, nunca
// `zona_ids`/`zona_nombres` ya resueltos contra la base), así que ya no hay ninguna operación con
// dependencia de DB en este gate. Se deja el set vacío (en vez de borrarlo) para que, si en el
// futuro se agrega una operación con esa misma dependencia, el patrón ya esté armado.
const OPERATIONS_INFORMATIONAL_ONLY = new Set<string>([]);

function loadReport(filePath: string): EvalReportFile {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseArg(args: string[], flag: string): string | null {
  const idx = args.findIndex(a => a === flag);
  return idx === -1 ? null : (args[idx + 1] ?? null);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

interface MetricComparison {
  key: string;
  baseline: number;
  current: number;
  isRegression: boolean;
  gates: boolean;
}

function compareMetric(key: string, baselineValue: number, currentValue: number, thresholdPoints: number, gates: boolean): MetricComparison {
  if (INFORMATIONAL_ONLY.has(key)) {
    return { key, baseline: baselineValue, current: currentValue, isRegression: false, gates: false };
  }
  let isRegression: boolean;
  if (HIGHER_IS_BETTER.has(key)) {
    isRegression = baselineValue - currentValue > thresholdPoints;
  } else if (LOWER_IS_BETTER.has(key)) {
    isRegression = currentValue - baselineValue > thresholdPoints;
  } else {
    isRegression = false; // métrica desconocida: se muestra, no gatea (no fabricar una regla que no conocemos)
  }
  return { key, baseline: baselineValue, current: currentValue, isRegression, gates };
}

function formatMetricRow(c: MetricComparison): string {
  const isFraction = !INFORMATIONAL_ONLY.has(c.key);
  const baselineStr = isFraction ? pct(c.baseline) : c.baseline.toFixed(0);
  const currentStr = isFraction ? pct(c.current) : c.current.toFixed(0);
  const deltaRaw = c.current - c.baseline;
  const deltaStr = isFraction ? `${deltaRaw >= 0 ? '+' : ''}${(deltaRaw * 100).toFixed(1)}pp` : `${deltaRaw >= 0 ? '+' : ''}${deltaRaw.toFixed(0)}`;
  let status: string;
  if (!c.gates) status = 'ℹ️ informativo';
  else if (c.isRegression) status = '❌ REGRESIÓN';
  else status = '✅';
  return `| ${c.key} | ${baselineStr} | ${currentStr} | ${deltaStr} | ${status} |`;
}

function main() {
  const args = process.argv.slice(2);
  const baselinePath = parseArg(args, '--baseline');
  const currentPath = parseArg(args, '--current');
  const outPath = parseArg(args, '--out');
  const thresholdArg = parseArg(args, '--threshold');
  const thresholdPoints = thresholdArg ? parseFloat(thresholdArg) : 0.05; // 5 puntos porcentuales

  if (!baselinePath || !currentPath) {
    console.error('Uso: ts-node evals/compare-to-baseline.ts --baseline <path> --current <path> [--out <path>] [--threshold 0.05]');
    process.exit(1);
  }

  const baseline = loadReport(baselinePath);
  const current = loadReport(currentPath);

  const lines: string[] = [];
  lines.push('## 🧪 Eval gate (BE-05)');
  lines.push('');
  lines.push(`Comparando el reporte de este PR contra el baseline de \`${baseline.date}\` (threshold: ${(thresholdPoints * 100).toFixed(0)} puntos porcentuales).`);
  lines.push('');

  let hasGatingFailure = false;

  for (const currentOp of current.reports) {
    const baselineOp = baseline.reports.find(r => r.operation === currentOp.operation);
    const gatesThisOp = !OPERATIONS_INFORMATIONAL_ONLY.has(currentOp.operation);

    lines.push(`### ${currentOp.operation}${gatesThisOp ? '' : ' _(informativo — requiere DB real, no disponible en CI)_'}`);
    lines.push('');
    lines.push(`- Casos ejecutados: ${currentOp.executedCases}/${currentOp.totalCases}`);

    if (currentOp.criticalFailure) {
      lines.push('- ⚠️ **FALLA CRÍTICA**: ningún caso pudo ejecutarse (revisar credenciales/cuota de la API).');
      lines.push('');
      if (gatesThisOp) hasGatingFailure = true;
      continue;
    }

    if (!baselineOp) {
      lines.push('- (sin baseline para esta operación — no se compara)');
      lines.push('');
      continue;
    }

    lines.push('');
    lines.push('| Métrica | Baseline | Este PR | Delta | Estado |');
    lines.push('|---|---|---|---|---|');
    for (const [key, currentValue] of Object.entries(currentOp.metrics)) {
      const baselineValue = baselineOp.metrics[key];
      if (baselineValue === undefined) continue;
      const comparison = compareMetric(key, baselineValue, currentValue, thresholdPoints, gatesThisOp);
      lines.push(formatMetricRow(comparison));
      if (comparison.gates && comparison.isRegression) hasGatingFailure = true;
    }
    lines.push('');
  }

  lines.push(hasGatingFailure
    ? '**Resultado: ❌ el gate encontró al menos una regresión de calidad.**'
    : '**Resultado: ✅ sin regresiones de calidad por encima del umbral.**');

  const markdown = lines.join('\n');
  console.log(markdown);
  if (outPath) fs.writeFileSync(outPath, markdown, 'utf8');

  process.exit(hasGatingFailure ? 1 : 0);
}

main();
