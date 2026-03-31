# Contributing to Claude Pilot

Thank you for your interest in contributing to Claude Pilot!

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/claude-pilot.git`
3. Install dependencies: `npm install`
4. Run tests: `npm test`

## Development

```bash
# Start the server
node cli.js server --port 3456

# Run unit tests
npm test

# Run E2E tests (requires Playwright)
npm run test:e2e

# Run all tests
npm run test:all
```

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes
3. Ensure all tests pass (`npm run test:all`)
4. Update documentation if needed
5. Submit a pull request

### PR Guidelines

- Keep PRs focused on a single change
- Write clear commit messages
- Add tests for new features
- Do not include unrelated changes

## Code Style

- ESM modules (`import/export`)
- No TypeScript (vanilla JavaScript)
- CSS in `public/style.css` (no inline styles in HTML)
- Server logic in `server.js`, gate evaluation in `gate-engine.js`

## Reporting Issues

- Use GitHub Issues for bug reports and feature requests
- Check existing issues before creating a new one
- Include reproduction steps for bugs

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting.
