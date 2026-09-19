# Demo verification

## 1. Compile and test

Run the platform-specific test script. It compiles all Java sources with `--release 11` and runs `ResilienceEngineTest`.

## 2. Start the server

Run the demo script and open the printed local URL.

## 3. Exercise the dashboard

Click success, failure, slow response, and local HTTP probe. Metrics should update after each request.

## 4. Direct endpoint checks

Use a browser, `curl`, or another HTTP client to check `/api/health`, `/api/metrics`, and the three simulation modes.

## 5. Expected behavior

- `success`: one operation attempt and no fallback.
- `fail`: bounded retries followed by fallback.
- `slow`: delayed successful operation.
- `probe`: actual Java `HttpClient` request to a localhost endpoint.

The exact elapsed time depends on the machine and scheduler, so timing values are informational rather than exact test assertions.
