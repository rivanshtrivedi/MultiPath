package multipath;

import java.util.concurrent.atomic.AtomicInteger;

public final class ResilienceEngineTest {
    public static void main(String[] args) throws Exception {
        testImmediateSuccess();
        testRecoveryAfterTemporaryFailures();
        testFallbackAfterExhaustion();
        testNonRetryableFailure();
        testBackoffCap();
        System.out.println("ALL TESTS PASSED");
    }

    private static void testImmediateSuccess() {
        AtomicInteger sleeps = new AtomicInteger();
        ResilienceEngine engine = new ResilienceEngine(RetryPolicy.defaults(), ms -> sleeps.incrementAndGet());
        ResilienceResult<String> result = engine.execute(() -> "ok", () -> "fallback", ex -> true);
        check(result.isSuccess(), "immediate success should succeed");
        check(result.getAttempts() == 1, "immediate success should use one attempt");
        check(!result.isFallbackUsed(), "immediate success should not fallback");
        check(sleeps.get() == 0, "immediate success should not sleep");
    }

    private static void testRecoveryAfterTemporaryFailures() {
        AtomicInteger calls = new AtomicInteger();
        ResilienceEngine engine = new ResilienceEngine(new RetryPolicy(3, 1, 10, 2, 0), ms -> {});
        ResilienceResult<String> result = engine.execute(() -> {
            if (calls.incrementAndGet() < 3) throw new RetryableException("temporary");
            return "recovered";
        }, () -> "fallback", ex -> ex instanceof RetryableException);
        check(result.isSuccess(), "temporary failures should recover");
        check(result.getAttempts() == 3, "recovery should take three attempts");
        check("recovered".equals(result.getValue()), "recovered value should be returned");
    }

    private static void testFallbackAfterExhaustion() {
        AtomicInteger calls = new AtomicInteger();
        ResilienceEngine engine = new ResilienceEngine(new RetryPolicy(3, 1, 10, 2, 0), ms -> {});
        ResilienceResult<String> result = engine.execute(() -> {
            calls.incrementAndGet();
            throw new RetryableException("down");
        }, () -> "fallback", ex -> ex instanceof RetryableException);
        check(!result.isSuccess(), "exhausted retries should not report success");
        check(result.isFallbackUsed(), "exhausted retries should use fallback");
        check(result.getAttempts() == 3, "fallback should occur after max attempts");
        check(calls.get() == 3, "operation should be called three times");
        check("fallback".equals(result.getValue()), "fallback value should be returned");
    }

    private static void testNonRetryableFailure() {
        AtomicInteger calls = new AtomicInteger();
        ResilienceEngine engine = new ResilienceEngine(RetryPolicy.defaults(), ms -> {});
        ResilienceResult<String> result = engine.execute(() -> {
            calls.incrementAndGet();
            throw new IllegalArgumentException("bad input");
        }, () -> "fallback", ex -> ex instanceof RetryableException);
        check(calls.get() == 1, "non-retryable failure should not retry");
        check(result.isFallbackUsed(), "non-retryable failure should fallback");
    }

    private static void testBackoffCap() {
        RetryPolicy policy = new RetryPolicy(5, 100, 250, 2.0, 0);
        check(policy.backoffMillis(1) == 100, "first backoff mismatch");
        check(policy.backoffMillis(2) == 200, "second backoff mismatch");
        check(policy.backoffMillis(3) == 250, "backoff should cap");
        check(policy.backoffMillis(4) == 250, "backoff should remain capped");
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
