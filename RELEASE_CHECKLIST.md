# Release checklist

- [x] Java 11 API compatibility enforced with `--release 11`.
- [x] Core resilience unit-style tests pass.
- [x] Local HTTP server starts successfully on a free port.
- [x] Dashboard is served and contains expected application content.
- [x] Success, failure/fallback, and slow simulations verified.
- [x] Real Java `HttpClient` probe verified against local endpoint.
- [x] Metrics endpoint verified.
- [x] Localhost-first network default documented.
- [x] Security guidance included.
- [x] CI workflow included for Java 11/17/21.
- [x] Issue templates included.
- [x] Changelog and architecture documentation included.
- [x] Demo instructions included.

## Remaining before a public GitHub tag

- Replace placeholder repository metadata with the actual GitHub URL/owner.
- Review license copyright holder.
- Run CI on the actual GitHub repository.
- Add screenshots or a short demo GIF if desired.
- Tag a release only after the repository CI is green.
