# Security Policy

## Supported versions

Security fixes are applied to the latest version on the default branch.

## Reporting a vulnerability

Please do not disclose security vulnerabilities in public GitHub issues.

Instead:

1. Send a private report to the repository maintainer.
2. Include reproduction steps and impact.
3. Include affected endpoints/configuration.

You should receive an initial response within 7 days.

## Recommended hardening

- Set `API_PASSWORD` in production.
- Restrict network access (private subnet, VPN, firewall, reverse proxy allowlist).
- Monitor request volume and queue saturation.
- Keep dependencies updated.
