// Raw, un-normalized telemetry for service-b across 12 one-minute windows.
//
// This is the *input* to the detection engine — actual metric values in their
// native units, not precomputed z-scores. The engine in lib/detectionEngine.js
// derives everything else (z-scores, qualified signals, R-score, trigger) from
// these numbers live. Edit a value here and the whole pipeline recomputes.
//
//   p99_latency : milliseconds   (healthy baseline ~100ms)
//   retry_rate  : percent         (healthy baseline ~0.5%)
//   error_rate  : percent         (healthy baseline ~0.2%)
//
// The scenario: a connection-pool exhaustion on service-b. Latency drifts first,
// a client retry storm amplifies it, and error rate joins last as the failure
// propagates downstream — the classic cascade signature.

export const RAW_TELEMETRY = [
  { window_number: 1, window_timestamp: '2026-01-01T10:01:00Z', p99_latency: 112, retry_rate: 0.4, error_rate: 0.63 },
  { window_number: 2, window_timestamp: '2026-01-01T10:02:00Z', p99_latency: 82, retry_rate: 0.67, error_rate: 0.24 },
  { window_number: 3, window_timestamp: '2026-01-01T10:03:00Z', p99_latency: 128, retry_rate: 0.16, error_rate: 0.78 },
  { window_number: 4, window_timestamp: '2026-01-01T10:04:00Z', p99_latency: 98, retry_rate: 0.97, error_rate: 0.15 },
  { window_number: 5, window_timestamp: '2026-01-01T10:05:00Z', p99_latency: 145, retry_rate: 0.85, error_rate: 0.69 },
  { window_number: 6, window_timestamp: '2026-01-01T10:06:00Z', p99_latency: 154, retry_rate: 1.03, error_rate: 0.78 },
  { window_number: 7, window_timestamp: '2026-01-01T10:07:00Z', p99_latency: 155, retry_rate: 1.27, error_rate: 0.9 },
  { window_number: 8, window_timestamp: '2026-01-01T10:08:00Z', p99_latency: 170, retry_rate: 1.57, error_rate: 1.14 },
  { window_number: 9, window_timestamp: '2026-01-01T10:09:00Z', p99_latency: 181, retry_rate: 1.75, error_rate: 1.44 },
  { window_number: 10, window_timestamp: '2026-01-01T10:10:00Z', p99_latency: 199, retry_rate: 1.99, error_rate: 1.71 },
  { window_number: 11, window_timestamp: '2026-01-01T10:11:00Z', p99_latency: 227, retry_rate: 2.35, error_rate: 2.07 },
  { window_number: 12, window_timestamp: '2026-01-01T10:12:00Z', p99_latency: 267, retry_rate: 2.95, error_rate: 2.73 },
]
