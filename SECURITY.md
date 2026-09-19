# Security policy

## Scope

MultiPath is a local resilience demonstration. It is not designed to be exposed directly to the public internet.

## Safe defaults

- Server binds to `127.0.0.1` by default.
- The HTTP probe endpoint accepts only localhost HTTP targets.
- No authentication secrets or credentials are generated.
- Responses include basic browser hardening headers.
- The dashboard uses DOM text assignment rather than injecting server responses as HTML.

## Network warning

If `MULTIPATH_HOST=0.0.0.0` is used for mobile testing, restrict access to a trusted LAN/firewall and do not forward the port from the internet.

## Reporting

For a suspected security issue in a public fork, open a private security report if the hosting platform provides that feature. Do not publish credentials, private data, or exploit payloads in a public issue.
