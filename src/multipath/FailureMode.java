package multipath;

public enum FailureMode {
    SUCCESS("success"),
    FAIL("fail"),
    SLOW("slow");

    private final String value;

    FailureMode(String value) {
        this.value = value;
    }

    public String value() {
        return value;
    }

    public static FailureMode from(String value) {
        if (value == null) return SUCCESS;
        for (FailureMode mode : values()) {
            if (mode.value.equalsIgnoreCase(value)) return mode;
        }
        return SUCCESS;
    }
}
