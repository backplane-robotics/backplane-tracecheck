# Contributing

Thanks for your interest in Backplane Tracecheck. Bug reports, synthetic test recordings and focused pull requests are welcome.

## Ground rules

- **Behaviour must stay identical in Python and the browser.** Any change to a check needs the same change in `src/tracecheck/` and `web/src/engine/`. Both test suites compare results against `examples/expected.json`.
- **Never commit real recordings.** Add synthetic cases in `src/tracecheck/samples.py` instead.
- Keep checks conservative and evidence-backed. When a conclusion can't be justified, the right result is `skipped`.

## Workflow

```bash
pip install -e ".[dev]"
python -m pytest
cd web && npm install && npm test
```

After an intentional behaviour change:

```bash
tracecheck samples && python tools/make_golden.py
```

Review the diff in `examples/expected.json` and mention it in your pull request and in `CHANGELOG.md` under *Unreleased*.

By contributing, you agree that your contributions are licensed under the Apache License 2.0.
