# Security Policy

This project follows the [Iflytek Opensource Community Security Policy](https://github.com/iflytek/community/blob/master/SECURITY.md).

For project-specific security considerations, see below.

## Reporting a Vulnerability

Please report security issues privately through GitHub Security Advisories when
available for this repository. If advisories are unavailable, open a minimal
issue that says you have a security report without including exploit details.

## Memory Safety Scope

MemFlywheel stores memory in local files. Callers are responsible for choosing the
memory root and controlling filesystem access to that root.

| Surface                        | Current Behavior                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `<private>...</private>` spans | Always redacted before persistence.                                                      |
| Hard secret scan               | Optional through injected core/SDK write configuration; host integrations decide policy. |
| Audit logs                     | Must not contain raw secret material.                                                    |
| LLM access                     | Core never calls an LLM directly. Model calls are injected by the host or SDK runner.    |

Do not place real credentials, tokens, private keys, or regulated personal data
in examples, tests, issues, pull requests, or documentation.
