# Security Policy

## Supported versions

FAULTLINE is pre-1.0. Security fixes land on `main`; there are no maintained
release branches yet.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report privately through
[GitHub Security Advisories](https://github.com/Harshith029/faultline/security/advisories/new),
or by email to **harshith.pali3286@gmail.com**.

Include what you need to make the issue reproducible: affected component, a
proof of concept if you have one, and the impact you believe it has.

This is a small open-source project maintained in spare time, so treat these as
intentions rather than a commercial SLA:

| Stage | Target |
|---|---|
| Acknowledgement | within 5 days |
| Initial assessment | within 14 days |
| Fix or documented mitigation | depends on severity, discussed with you |

Credit is given in the advisory unless you prefer otherwise.

## Attack surface

The agent has three ways in and three ways out. Everything else is local
computation.

**Inbound**

- **HTTP API** (`server.port`, default `127.0.0.1:8787`). Serves state and
  metrics, and accepts writes: creating silences and injecting synthetic
  faults. A silence suppresses alerting, so unauthenticated write access is a
  genuine availability risk, not just an information leak.
- **Config file**, trusted input, read once at startup.
- **The state file** at `storage.path`, trusted, read at startup.

**Outbound**

- The telemetry source you configure (Prometheus, CloudWatch, or an HTTP
  endpoint).
- Notifier webhooks you configure.
- Nothing else. There is no telemetry, analytics, update check, or phone-home
  of any kind.

## Hardening checklist

- [ ] Set `FAULTLINE_API_TOKEN`. Without it the API is open and the agent logs a
      `server.unauthenticated` warning at startup.
- [ ] Use `FAULTLINE_READ_TOKEN` for scrapers so Prometheus cannot create
      silences.
- [ ] Enable TLS (`server.tls`) or terminate it at your ingress. Binding beyond
      `127.0.0.1` without TLS logs a `server.plaintext` warning.
- [ ] Keep the API off the public internet regardless of authentication.
- [ ] Set `server.corsOrigin` to your dashboard origin instead of `*` if a
      browser will call the API.
- [ ] Store webhook URLs in `urlEnv`, never inline. Literal tokens in config are
      rejected at startup, and a webhook URL is a credential.
- [ ] Put the state file on a volume only the agent user can read: it contains
      incident history and buffered telemetry.

## Design decisions relevant to security

- **Zero runtime dependencies.** The agent and engine import nothing outside
  the Node standard library, so there is no third-party supply chain to audit
  or patch. The AWS SDK is loaded lazily and only if you configure the
  CloudWatch source.
- **Constant-time token comparison.** Tokens are compared as SHA-256 digests
  via `timingSafeEqual`, so neither the value nor the length leaks through
  response timing.
- **Credentials cannot live in config.** A literal `token` in the config file
  is a startup error, because config files get committed.
- **TLS fails closed.** A configured but unreadable certificate stops the agent
  starting rather than silently downgrading to plaintext.
- **`/health` is deliberately anonymous.** Probes must reach it before any
  credential exists; it exposes no telemetry.
- **Request bodies are capped** at 64 KB.

## Known limitations

Stated plainly so you can decide whether they matter to you:

- Authorisation is two fixed scopes (read, read-write). There is no per-user
  identity, RBAC, or audit trail of who created a silence.
- Tokens are static. There is no rotation mechanism, expiry, or revocation list
  beyond changing the environment variable and restarting.
- There is no rate limiting on the API.
- Incident history and buffered telemetry are stored unencrypted on disk.
