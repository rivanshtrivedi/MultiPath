package multipath;

public final class HttpResponseData {
    private final int statusCode;
    private final String body;
    private final long elapsedMillis;

    public HttpResponseData(int statusCode, String body, long elapsedMillis) {
        this.statusCode = statusCode;
        this.body = body;
        this.elapsedMillis = elapsedMillis;
    }

    public int getStatusCode() { return statusCode; }
    public String getBody() { return body; }
    public long getElapsedMillis() { return elapsedMillis; }
}
