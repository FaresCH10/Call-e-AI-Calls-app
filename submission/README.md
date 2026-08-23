# Hackathon submission

Prepared for [`CALLE-AI/awesome-phone-call-agents`](https://github.com/CALLE-AI/awesome-phone-call-agents),
following that repository's current `CONTRIBUTING.md`.

## Where it goes

Per the contribution table, a runnable app belongs in
`apps/<language-or-runtime>/<app-name>/`:

```
apps/typescript/dial/
```

The entry in `submission/apps/typescript/dial/README.md` is written to that
repository's house style: what the app does, what it costs, what side effects it
has, how to run it without calling anyone, and what it refuses to do.

## Submitting

```bash
git clone https://github.com/CALLE-AI/awesome-phone-call-agents
cd awesome-phone-call-agents
mkdir -p apps/typescript/dial
cp -r /path/to/Dial/. apps/typescript/dial/     # excluding .env, node_modules, dist
cp /path/to/Dial/submission/apps/typescript/dial/README.md apps/typescript/dial/README.md

python3 scripts/validate_repository.py
```

Then open a pull request. Add an awesome-list entry to the root `README.md` if
the maintainers ask for one.

## Checklist, against their list

| Requirement | Dial |
| --- | --- |
| English-only repository-facing content | yes |
| No secrets, tokens, private numbers or personal data | `.env` is gitignored; `.env.example` is placeholders only |
| States what host/provider it supports | CALL-E via `@call-e/calle@^0.7.0`, stated in the README |
| Clearly describes side effects | a dedicated section: it makes real phone calls to real businesses |
| Install and usage instructions | yes, and they have been run end to end |
| Phone numbers masked in samples | API responses mask to `+35***00`; sample numbers are the reserved `555-01xx` range |
| Cancellation / rollback for recurring work | there is no recurring work; task cancellation and its documented limit are described |
| Dry-run / fake-server / no-call path | `TEST_PROVIDER=mock` is the **default**, and `real` without a key refuses to boot |
| Passes repository validation | run `scripts/validate_repository.py` after copying |

## Not claimed

No pull request has been opened, and no real phone call has been placed. Both
are noted honestly in the submission README rather than implied.
