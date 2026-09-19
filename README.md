# MultiPath

MultiPath is a zero-dependency Java 11 resilience laboratory that demonstrates bounded retries, exponential backoff, fallback behavior, HTTP timeouts, failure classification, local failure injection, and a responsive browser dashboard.

## What is implemented

- Java 11-compatible source (`javac --release 11`).
- No third-party runtime or test dependencies.
- Bounded retry policy with capped exponential backoff and deterministic jitter.
- Retryable vs non-retryable failure classification.
- Fallback execution after exhaustion or non-retryable failure.
- Java `HttpClient` request execution with connect/request timeouts.
- Local HTTP simulation endpoints for success, failure, and slow responses.
- Metrics for requests, retries, fallbacks, successes, failures, and last latency.
- Responsive static dashboard served by the Java server.
- Automated smoke tests without JUnit.
- GitHub Actions CI for compilation and tests.
- Localhost-first network binding and security guidance.

## Requirements

- JDK 11 or newer.
- No Maven or Gradle required.

## Run

### Linux/macOS

```bash
./scripts/test.sh
./scripts/run-demo.sh
```

### Windows

```bat
scripts\test.bat
scripts\run-demo.bat
```

Then open `http://127.0.0.1:8080/`.

## Manual API checks

```text
GET /api/health
GET /api/metrics
GET /api/simulate?mode=success
GET /api/simulate?mode=fail
GET /api/simulate?mode=slow
GET /api/probe?url=http%3A%2F%2F127.0.0.1%3A8080%2Fapi%2Fhealth
```

A `fail` simulation intentionally exhausts retries and demonstrates fallback. A `slow` simulation delays the local operation but remains within the demo engine's retry policy.

## Configuration

Environment variables:

- `MULTIPATH_HOST` — default `127.0.0.1`.
- `MULTIPATH_PORT` — default `8080`.
- `MULTIPATH_WEB` — default `web`.

For mobile testing on a trusted local network, you can bind to the machine's LAN interface or `0.0.0.0`, but this demo server is not intended for public exposure.

## Architecture

```text
Browser dashboard
       |
       v
MultiPathServer
  |    |    |    \
  |    |    |     +--> Metrics
  |    |    +--------> HTTP probe -> HttpRequestExecutor -> Java HttpClient
  |    +-------------> Simulation -> ResilienceEngine
  +------------------> Static dashboard

ResilienceEngine
  -> retry policy
  -> failure classification
  -> bounded backoff
  -> fallback
  -> result metadata
```

See `ARCHITECTURE.md` for design details and `docs/DEMO.md` for a verification walkthrough.

## Security posture

MultiPath is a local engineering demonstration, not a production reverse proxy or public API gateway. It deliberately limits the probe endpoint to localhost targets, binds to localhost by default, avoids secrets, and emits browser security headers. See `SECURITY.md`.

## Project roadmap

The project is organized around five engineering layers:

1. Resilience foundation.
2. Real HTTP resilience.
3. Observability.
4. Production-style quality.
5. Public release hygiene.

All five layers are initialized in this repository; later improvements can extend them without changing the core contract.
