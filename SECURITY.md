# Security policy

Volc Agent Launchpad is a hackathon proof of concept. Only the latest revision
on the default branch is supported.

## Report a vulnerability

Send the repository owner or event organizer the affected revision,
reproduction steps, impact, and suggested mitigation. Do not publish
credentials, personal data, or exploit details in an issue.

## Known limitations

- Per-user identity and Agent ownership via Supabase Auth, but no RBAC,
  delegation, or tenant isolation beyond per-account ownership
- No CSRF protection
- No per-Agent container boundary in ECS mode
- Ordinary local containers, not hardened multi-tenant sandboxes
- Broad outbound network access
- Prompt-triggered command and file execution
- Ark key available to the server and active Runtime container
- Ark key stored in Terraform POC state

## Safe use

- Use a dedicated development machine or disposable ECS instance.
- Use a scoped, revocable Ark key. The Supabase `service_role` key is
  optional (only needed for cross-machine Postgres persistence — see
  README.md#data-persistence-supabase) and bypasses all access control if
  set; use your own project's key, not a shared one, and never expose it to
  the browser.
- Keep local use on loopback and restrict ECS Web and SSH CIDRs.
- Add HTTPS before exposing sign-in over an untrusted network.
- Never mount production data or provide Volcengine account AK/SK to Agents.
- Stop the POC, destroy test resources, and revoke keys after the event.

Codex uses `workspace-write` when Landlock is available. On unsupported kernels,
startup warns and relies on the outer Docker or rootless Podman boundary. This
fallback is not tenant isolation.
