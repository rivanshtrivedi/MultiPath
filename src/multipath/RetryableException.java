package multipath;

public class RetryableException extends Exception {
    public RetryableException(String message) { super(message); }
    public RetryableException(String message, Throwable cause) { super(message, cause); }
}
