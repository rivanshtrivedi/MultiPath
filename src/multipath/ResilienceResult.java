package multipath;

public final class ResilienceResult<T> {
    private final T value;
    private final boolean success;
    private final boolean fallbackUsed;
    private final int attempts;
    private final long elapsedMillis;
    private final String message;

    public ResilienceResult(T value, boolean success, boolean fallbackUsed, int attempts,
                            long elapsedMillis, String message) {
        this.value = value;
        this.success = success;
        this.fallbackUsed = fallbackUsed;
        this.attempts = attempts;
        this.elapsedMillis = elapsedMillis;
        this.message = message;
    }

    public T getValue() { return value; }
    public boolean isSuccess() { return success; }
    public boolean isFallbackUsed() { return fallbackUsed; }
    public int getAttempts() { return attempts; }
    public long getElapsedMillis() { return elapsedMillis; }
    public String getMessage() { return message; }
}
