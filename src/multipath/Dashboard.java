package multipath;

/**
 * Legacy compatibility launcher. The production dashboard is served by MultiPathServer from web/index.html.
 */
public final class Dashboard {
    private Dashboard() {}

    public static void main(String[] args) throws Exception {
        MultiPathServer.main(args);
    }
}
