# Contributing

Thanks for considering a contribution.

## Quick start

1. Fork the repository.
2. Create a branch: `git checkout -b feat/short-description`
3. Install dependencies: `npm install`
4. Run checks: `npm run check`
5. Commit with clear messages.
6. Open a pull request.

## Coding rules

- Keep code simple and readable.
- Keep JSON responses consistent (`{ ok, ... }`).
- Keep changes small and focused.
- Update `README.md` when behavior or configuration changes.
- Update `MEMORY.md` and `MISTAKES.md` with important lessons.

## Pull request checklist

- [ ] Code builds and syntax check passes (`npm run check`)
- [ ] Docs updated (`README.md`, env examples, or endpoint docs)
- [ ] New env vars are documented in `.env.example`
- [ ] Changes tested manually when relevant

## Reporting issues

- Use the issue templates in `.github/ISSUE_TEMPLATE`.
- Include steps to reproduce, expected behavior, and logs if possible.

## Security issues

Do not open public issues for sensitive security findings.
Please follow `SECURITY.md`.
