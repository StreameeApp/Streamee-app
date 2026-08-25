let traceCounter = 0;

interface PerformanceTrace {
  mark: (stage: string) => number;
  finish: (stage: string) => number;
}

export function createPerformanceTrace(scope: string): PerformanceTrace {
  const traceId = ++traceCounter;
  const startMark = `streamee:${scope}:${traceId}:start`;
  const startTime = performance.now();
  performance.mark(startMark);

  const record = (stage: string, finished: boolean): number => {
    const duration = performance.now() - startTime;
    const endMark = `streamee:${scope}:${traceId}:${stage}`;
    const measureName = `Streamee ${scope} ${stage}`;
    performance.mark(endMark);
    performance.measure(measureName, { start: startTime, end: performance.now() });
    performance.clearMarks(endMark);
    console.info(`[Performance] ${scope} ${stage}: ${duration.toFixed(1)}ms`);

    if (finished) {
      window.setTimeout(() => performance.clearMarks(startMark), 1000);
    }
    return duration;
  };

  return {
    mark: (stage) => record(stage, false),
    finish: (stage) => record(stage, true)
  };
}
