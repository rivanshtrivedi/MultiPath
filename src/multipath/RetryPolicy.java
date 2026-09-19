package multipath;

public final class RetryPolicy {
    private final int maxAttempts;
    private final long initialBackoffMillis;
    private final long maxBackoffMillis;
    private final double multiplier;
    private final long jitterMillis;

    public RetryPolicy(int maxAttempts, long initialBackoffMillis, long maxBackoffMillis,
                       double multiplier, long jitterMillis) {
        if (maxAttempts < 1) throw new IllegalArgumentException("maxAttempts must be >= 1");
        if (initialBackoffMillis < 0) throw new IllegalArgumentException("initialBackoffMillis must be >= 0");
        if (maxBackoffMillis < initialBackoffMillis) throw new IllegalArgumentException("maxBackoffMillis must be >= initialBackoffMillis");
        if (multiplier < 1.0) throw new IllegalArgumentException("multiplier must be >= 1");
        if (jitterMillis < 0) throw new IllegalArgumentException("jitterMillis must be >= 0");
        this.maxAttempts = maxAttempts;
        this.initialBackoffMillis = initialBackoffMillis;
        this.maxBackoffMillis = maxBackoffMillis;
        this.multiplier = multiplier;
        this.jitterMillis = jitterMillis;
    }

    public static RetryPolicy defaults() {
        return new RetryPolicy(3, 100, 1000, 2.0, 25);
    }

    public int getMaxAttempts() { return maxAttempts; }
    public long getInitialBackoffMillis() { return initialBackoffMillis; }
    public long getMaxBackoffMillis() { return maxBackoffMillis; }
    public double getMultiplier() { return multiplier; }
    public long getJitterMillis() { return jitterMillis; }

    public long backoffMillis(int failedAttempt) {
        if (failedAttempt < 1) return 0;
        double raw = initialBackoffMillis * Math.pow(multiplier, failedAttempt - 1);
        long capped = (long) Math.min(maxBackoffMillis, raw);
        if (jitterMillis == 0) return capped;
        long deterministicJitter = Math.min(jitterMillis, Math.max(0, capped / 4));
        return capped + deterministicJitter;
    }
}
