# Application privacy and security review

Reviewed during the October 12, 2026 Path 2 Entrypoint B Codex standardization. Base commit: 68138ce692356daf28bf5daba7932abcfc987b93. Candidate changes are described below; this document alone does not claim they are deployed.

Confirmed live MCP discovery accepts unauthenticated requests; no health records were fetched. Candidate requires a nonempty bearer token before every HTTP route, uses constant-time comparison, and avoids parsing untrusted Host as a URL base. Isolated unauthorized/wrong-token/authorized tests pass. Read-only SQL, FlashAir ingestion, Keychain writer and owner-only creation reviewed. Live endpoint remains unauthenticated until this runtime release and client-header cutover are completed.

Scope: tracked source and scripts, raw Git metadata and full-history patch scans, production dependency manifests, actual package file inventory, local authentication boundaries, credential/logging paths, local data permissions, and separately managed runtime components where present. Scanner PASS is a limited set of checks, not a guarantee against all vulnerabilities. This was not an external penetration test or exhaustive formal verification. Live personal content was not copied into this repository, PRs or Notion.

Evidence: repository dependency/code gates and their negative enforcement tests; local build and relevant application tests; disposable Keychain create/update/escaping/large-session readbacks with cleanup; local HTTP authorization probes; ShellCheck and macOS Clang where applicable. Reviewed historical public automation identities remain exact; prospective commits require GitHub noreply.
