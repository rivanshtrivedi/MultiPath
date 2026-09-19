# Contributing

Thanks for contributing to MultiPath.

## Development rules

- Keep the project zero-dependency unless a change explicitly documents why that constraint must change.
- Preserve Java 11 compatibility.
- Prefer standard runtime libraries.
- Keep classes focused and APIs small.
- Add or update tests for behavioral changes.
- Do not introduce secrets, authentication tokens, or real external service credentials into examples.
- Keep local network behavior safe by default.
- Use readable, self-documenting code and meaningful names.

## Validation

Before submitting a change:

```bash
./scripts/test.sh
```

On Windows:

```bat
scripts\test.bat
```

If the change affects the dashboard or server, also run the demo and exercise the relevant endpoint manually.
