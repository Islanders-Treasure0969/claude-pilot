# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.6.x   | Yes       |
| < 0.6   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability in Claude Pilot, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

### How to Report

Open a [private vulnerability report](https://github.com/Islanders-Treasure0969/claude-pilot/security/advisories/new) on GitHub.

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Fix release**: Within 2 weeks for critical issues

### Safe Harbor

We will not take legal action against security researchers who:
- Make a good faith effort to avoid privacy violations, data destruction, or service disruption
- Report vulnerabilities privately before public disclosure
- Allow reasonable time for a fix before disclosure

## Security Design

Claude Pilot is a **local development tool** designed to run on 127.0.0.1 only. It is not intended for deployment as a public-facing server.

### Key Security Measures

- Server binds to 127.0.0.1 (localhost only)
- Input validation on all API endpoints
- CSP, X-Frame-Options, X-Content-Type-Options headers
- HTML escaping for all user content
- execFile (not exec) for command execution
- No hardcoded secrets
- npm audit: 0 vulnerabilities
