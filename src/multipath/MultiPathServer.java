package multipath;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MultiPathServer {
    private final HttpServer server;
    private final ExecutorService executor;
    private final Metrics metrics = new Metrics();
    private final ResilienceEngine engine = new ResilienceEngine(RetryPolicy.defaults());
    private final HttpRequestExecutor http = new HttpRequestExecutor(java.time.Duration.ofSeconds(2));
    private final Path webRoot;

    private MultiPathServer(String host, int port, Path webRoot) throws IOException {
        this.server = HttpServer.create(new InetSocketAddress(host, port), 0);
        this.executor = Executors.newCachedThreadPool();
        this.webRoot = webRoot;
        server.setExecutor(executor);
        server.createContext("/", new DashboardHandler());
        server.createContext("/api/health", new HealthHandler());
        server.createContext("/api/simulate", new SimulationHandler());
        server.createContext("/api/metrics", new MetricsHandler());
        server.createContext("/api/probe", new ProbeHandler());
    }

    public static void main(String[] args) throws Exception {
        String host = env("MULTIPATH_HOST", "127.0.0.1");
        int port = Integer.parseInt(env("MULTIPATH_PORT", "8080"));
        Path webRoot = Paths.get(env("MULTIPATH_WEB", "web")).toAbsolutePath().normalize();
        MultiPathServer app = new MultiPathServer(host, port, webRoot);
        Runtime.getRuntime().addShutdownHook(new Thread(app::stop));
        app.start();
        System.out.println("MultiPath running at http://" + host + ":" + port + "/");
        if (!"127.0.0.1".equals(host) && !"localhost".equalsIgnoreCase(host)) {
            System.out.println("WARNING: server is not localhost-only. Use only on a trusted network.");
        }
    }

    private void start() { server.start(); }

    private void stop() {
        server.stop(0);
        executor.shutdownNow();
    }

    private final class HealthHandler implements HttpHandler {
        public void handle(HttpExchange exchange) throws IOException {
            if (!"GET".equals(exchange.getRequestMethod())) { send(exchange, 405, "method not allowed", "text/plain"); return; }
            send(exchange, 200, "{\"status\":\"ok\",\"service\":\"MultiPath\"}", "application/json");
        }
    }

    private final class MetricsHandler implements HttpHandler {
        public void handle(HttpExchange exchange) throws IOException {
            if (!"GET".equals(exchange.getRequestMethod())) { send(exchange, 405, "method not allowed", "text/plain"); return; }
            send(exchange, 200, metrics.toJson(), "application/json");
        }
    }

    private final class SimulationHandler implements HttpHandler {
        public void handle(HttpExchange exchange) throws IOException {
            if (!"GET".equals(exchange.getRequestMethod())) { send(exchange, 405, "method not allowed", "text/plain"); return; }
            Map<String, String> query = parseQuery(exchange.getRequestURI());
            FailureMode mode = FailureMode.from(query.get("mode"));
            ResilienceResult<String> result = engine.execute(
                    () -> simulatedCall(mode),
                    () -> "fallback-response",
                    ex -> ex instanceof RetryableException);
            metrics.record(result);
            int status = result.isSuccess() ? 200 : 503;
            String body = "{"
                    + "\"mode\":" + Json.quote(mode.value()) + ","
                    + "\"success\":" + result.isSuccess() + ","
                    + "\"fallbackUsed\":" + result.isFallbackUsed() + ","
                    + "\"attempts\":" + result.getAttempts() + ","
                    + "\"elapsedMillis\":" + result.getElapsedMillis() + ","
                    + "\"message\":" + Json.quote(result.getMessage()) + ","
                    + "\"value\":" + Json.quote(result.getValue())
                    + "}";
            send(exchange, status, body, "application/json");
        }

        private String simulatedCall(FailureMode mode) throws Exception {
            if (mode == FailureMode.FAIL) throw new RetryableException("simulated upstream failure");
            if (mode == FailureMode.SLOW) Thread.sleep(450);
            return "upstream-response";
        }
    }

    private final class ProbeHandler implements HttpHandler {
        public void handle(HttpExchange exchange) throws IOException {
            if (!"GET".equals(exchange.getRequestMethod())) { send(exchange, 405, "method not allowed", "text/plain"); return; }
            Map<String, String> query = parseQuery(exchange.getRequestURI());
            String url = query.get("url");
            if (url == null || !(url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:"))) {
                send(exchange, 400, "{\"error\":\"url must target localhost\"}", "application/json");
                return;
            }
            ResilienceResult<HttpResponseData> result = engine.execute(
                    () -> {
                        HttpResponseData response = http.get(url);
                        if (response.getStatusCode() >= 500) throw new RetryableException("HTTP " + response.getStatusCode());
                        return response;
                    },
                    () -> new HttpResponseData(599, "local fallback", 0),
                    ex -> ex instanceof RetryableException || ex instanceof IOException || ex instanceof java.net.http.HttpTimeoutException);
            metrics.record(result);
            HttpResponseData value = result.getValue();
            String body = "{"
                    + "\"success\":" + result.isSuccess() + ","
                    + "\"fallbackUsed\":" + result.isFallbackUsed() + ","
                    + "\"attempts\":" + result.getAttempts() + ","
                    + "\"elapsedMillis\":" + result.getElapsedMillis() + ","
                    + "\"statusCode\":" + value.getStatusCode() + ","
                    + "\"body\":" + Json.quote(value.getBody()) + ","
                    + "\"message\":" + Json.quote(result.getMessage())
                    + "}";
            send(exchange, result.isSuccess() ? 200 : 503, body, "application/json");
        }
    }

    private final class DashboardHandler implements HttpHandler {
        public void handle(HttpExchange exchange) throws IOException {
            if (!"GET".equals(exchange.getRequestMethod())) { send(exchange, 405, "method not allowed", "text/plain"); return; }
            String path = exchange.getRequestURI().getPath();
            if (!"/".equals(path) && !"/index.html".equals(path)) { send(exchange, 404, "not found", "text/plain"); return; }
            Path file = webRoot.resolve("index.html").normalize();
            if (!file.startsWith(webRoot) || !Files.isRegularFile(file)) { send(exchange, 500, "dashboard not found", "text/plain"); return; }
            byte[] bytes = Files.readAllBytes(file);
            send(exchange, 200, bytes, "text/html; charset=utf-8");
        }
    }

    private static Map<String, String> parseQuery(URI uri) {
        Map<String, String> result = new HashMap<String, String>();
        String query = uri.getRawQuery();
        if (query == null || query.isEmpty()) return result;
        for (String pair : query.split("&")) {
            String[] parts = pair.split("=", 2);
            String key = decode(parts[0]);
            String value = parts.length == 2 ? decode(parts[1]) : "";
            result.put(key, value);
        }
        return result;
    }

    private static String decode(String value) {
        return java.net.URLDecoder.decode(value, StandardCharsets.UTF_8);
    }

    private static void send(HttpExchange exchange, int status, String body, String contentType) throws IOException {
        send(exchange, status, body.getBytes(StandardCharsets.UTF_8), contentType);
    }

    private static void send(HttpExchange exchange, int status, byte[] body, String contentType) throws IOException {
        Headers headers = exchange.getResponseHeaders();
        headers.set("Content-Type", contentType);
        headers.set("Cache-Control", "no-store");
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("X-Frame-Options", "DENY");
        headers.set("Referrer-Policy", "no-referrer");
        exchange.sendResponseHeaders(status, body.length);
        try (OutputStream out = exchange.getResponseBody()) { out.write(body); }
    }

    private static String env(String key, String fallback) {
        String value = System.getenv(key);
        return value == null || value.trim().isEmpty() ? fallback : value.trim();
    }
}
