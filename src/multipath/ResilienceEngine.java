package multipath;

import java.util.Objects;
import java.util.concurrent.Callable;
import java.util.function.Predicate;
import java.util.function.Supplier;

public final class ResilienceEngine {
    private final RetryPolicy policy;
    private final Sleeper sleeper;

    public interface Sleeper { void sleep(long millis) throws InterruptedException; }

    public ResilienceEngine(RetryPolicy policy) {
        this(policy, millis -> Thread.sleep(millis));
    }

    public ResilienceEngine(RetryPolicy policy, Sleeper sleeper) {
        this.policy = Objects.requireNonNull(policy, "policy");
        this.sleeper = Objects.requireNonNull(sleeper, "sleeper");
    }

    public <T> ResilienceResult<T> execute(Callable<T> operation, Supplier<T> fallback,
                                           Predicate<Exception> retryable) {
        Objects.requireNonNull(operation, "operation");
        Objects.requireNonNull(fallback, "fallback");
        Objects.requireNonNull(retryable, "retryable");

        long started = System.nanoTime();
        Exception last = null;
        for (int attempt = 1; attempt <= policy.getMaxAttempts(); attempt++) {
            try {
                T value = operation.call();
                return new ResilienceResult<T>(value, true, false, attempt, elapsed(started), "request succeeded");
            } catch (Exception ex) {
                last = ex;
                if (!retryable.test(ex) || attempt == policy.getMaxAttempts()) break;
                long delay = policy.backoffMillis(attempt);
                try {
                    sleeper.sleep(delay);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    last = interrupted;
                    break;
                }
            }
        }

        T fallbackValue = fallback.get();
        String message = last == null ? "fallback returned" : "fallback returned after: " + safeMessage(last);
        return new ResilienceResult<T>(fallbackValue, false, true, policy.getMaxAttempts(), elapsed(started), message);
    }

    private static long elapsed(long started) {
        return (System.nanoTime() - started) / 1_000_000L;
    }

    private static String safeMessage(Exception ex) {
        String message = ex.getMessage();
        return message == null || message.trim().isEmpty() ? ex.getClass().getSimpleName() : message;
    }
}
