# Migration status

MECON's Backend is moving into this repository one block at a time. Each block has a contract and synthetic conformance cases here, under `contracts/<name>/v1/`, checked by this repository's CI. The block moves in four stages:

1. **Contract published:** the contract and its cases are in this repository.
2. **Private reference passing:** the existing Backend, which is still private, replays the same cases in its own CI.
3. **Public implementation passing:** an implementation in this repository passes the same cases.
4. **Production switched:** a deployment runs on the public implementation behind a switch, with a tested way back.

Private code is removed only after stage 4. The core (accounts, identity, key custody, domain persistence and federation) moves last.

*Status as of 2026-11-23. Each entry records only what has been checked.*

| Block | Contract | 1. Published | 2. Private reference | 3. Public implementation | 4. Production |
|---|---|---|---|---|---|
| Reader API | [`reader-api/v1`](../contracts/reader-api/v1/openapi.yaml) | Yes: draft.10, 49 replayable cases | **Passing at draft.10**, in its own CI job (see below) | Not started | No |
| USB Connector | [`connector/v1`](../contracts/connector/v1/README.md), [`connector-hold/v1`](../contracts/connector-hold/v1/README.md) | Yes: wire contracts and fixtures | Not applicable: there is no private Connector | [`connector/`](../connector/README.md): passes its unit, fake-device and broker integration tests | No |
| Observation reads | [`observations/v1`](../contracts/observations/v1/openapi.yaml) | Schemas, fixtures and 11 replayable cases ([`cases/`](../contracts/observations/v1/cases/README.md)) | Schemas and fixtures checked; no case replay yet | Not started | No |
| Observation capture | [`observation-subscription/v1`](../contracts/observation-subscription/v1/README.md), [`raw-capture/v1`](../contracts/raw-capture/v1/README.md) | Drafts: schemas and fixtures | Not yet | In progress: [`capture/`](../capture/README.md) passes the capture contracts' fixtures in its own CI job | No |
| Observation processing | [`observation-processing/v1`](../contracts/observation-processing/v1/README.md) | Draft: schemas, replayable fixtures and a reference processor | Not yet | Not started | No |
| Job lifecycle and device dispatch | — | Not yet | Not yet | Not started | No |

## Reader API, stage 2

The private Backend vendors `contracts/reader-api/v1` at draft.10. It checks every vendored file against a pinned hash and replays each case in a dedicated CI job, which the server test gate requires. Its results:

- **47 cases pass.**
- **1 case is not applicable:** it covers a Backend that offers no offline leases, and this one always offers them.
- **1 case is an expected failure:** private channel names. The contract makes them unique within a fleet, but the private Backend still makes them unique across the instance. The decision is taken and the change is pending; the case is marked so that it fails the job once it starts passing unannounced.

The replay found one real difference: the login request accepted unknown body fields that the contract forbids. That is fixed, and since 2026-11-22 production refuses such a request with 422.

Later contract changes, starting with the cases revision after draft.10, are replayed once the private Backend re-vendors them.
