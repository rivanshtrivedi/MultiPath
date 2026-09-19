package multipath;

import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.LongAdder;

public final class Metrics {
    private final LongAdder requests = new LongAdder();
    private final LongAdder successes = new LongAdder();
    private final LongAdder fallbacks = new LongAdder();
    private final LongAdder retries = new LongAdder();
    private final LongAdder failures = new LongAdder();
    private final AtomicLong lastLatencyMillis = new AtomicLong(0);

    public void record(ResilienceResult<?> result) {
        requests.increment();
        if (result.isSuccess()) successes.increment();
        if (result.isFallbackUsed()) fallbacks.increment();
        if (result.getAttempts() > 1) retries.add(result.getAttempts() - 1L);
        if (!result.isSuccess()) failures.increment();
        lastLatencyMillis.set(result.getElapsedMillis());
    }

    public long getRequests() { return requests.sum(); }
    public long getSuccesses() { return successes.sum(); }
    public long getFallbacks() { return fallbacks.sum(); }
    public long getRetries() { return retries.sum(); }
    public long getFailures() { return failures.sum(); }
    public long getLastLatencyMillis() { return lastLatencyMillis.get(); }

    public String toJson() {
        return "{"
                + "\"requests\":" + getRequests() + ","
                + "\"successes\":" + getSuccesses() + ","
                + "\"failures\":" + getFailures() + ","
                + "\"fallbacks\":" + getFallbacks() + ","
                + "\"retries\":" + getRetries() + ","
                + "\"lastLatencyMillis\":" + getLastLatencyMillis()
                + "}";
    }
}
