# Architecture

## Core principles

1. **Small contracts:** retry policy, result metadata, and HTTP execution are separate concerns.
2. **Standard library only:** Java 11 APIs provide HTTP and the local server.
3. **Bounded behavior:** attempts and backoff are capped.
4. **Explicit fallback:** fallback is visible in the result instead of hidden.
5. **Safe local defaults:** localhost binding and localhost-only HTTP probing.
6. **Testability:** the resilience engine accepts an injectable sleeper so tests do not wait for real backoff.

## Components

### `ResilienceEngine`

Coordinates operation execution, retry classification, backoff, interruption handling, and fallback. It returns `ResilienceResult<T>` rather than throwing away useful execution metadata.

### `RetryPolicy`

Owns maximum attempts, initial delay, maximum delay, multiplier, and jitter. The policy is immutable.

### `HttpRequestExecutor`

Uses Java 11 `HttpClient` with connect and per-request timeouts. It returns status, body, and latency as `HttpResponseData`.

### `MultiPathServer`

Hosts the dashboard and API endpoints. The simulation endpoint exercises the resilience engine directly; the probe endpoint exercises real local HTTP calls through `HttpClient`.

### `Metrics`

Uses concurrent counters suitable for the cached-thread-pool server model.

## Failure flow

```text
operation
   |
   +-- success ----------------------> result(success)
   |
   +-- failure -> retryable? -- no --> fallback
   |                    |
   |                   yes
   |                    v
   |              attempts left?
   |               /          \
   |             yes           no
   |              |             |
   |          backoff          fallback
   |              |
   +--------------+
```

## Compatibility

The source intentionally avoids records, text blocks, virtual threads, and other post-Java-11 language/runtime features. CI compiles with `--release 11` so accidental use of newer APIs is caught.
