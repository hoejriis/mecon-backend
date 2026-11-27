# Migration status

MECON's Backend is moving into this repository one block at a time. Each block has a contract and synthetic conformance cases here, under `contracts/<name>/v1/`, checked by this repository's CI. The block moves in four stages:

1. **Contract published:** the contract and its cases are in this repository.
2. **Private reference passing:** the existing Backend, which is still private, replays the same cases in its own CI.
3. **Public implementation passing:** an implementation in this repository passes the same cases.
4. **Production switched:** a deployment runs on the public implementation behind a switch, with a tested way back.

Private code is removed only after stage 4. Blocks move in this order: capture and processing, then the observation contracts, the Reader API facade, the job lifecycle and device dispatch. The core (accounts, identity, key custody, domain persistence and federation) moves last.

*Status as of 2026-11-27. Each entry records only what has been checked.*

| Block | Contract | 1. Published | 2. Private reference | 3. Public implementation | 4. Production |
|---|---|---|---|---|---|
| Reader API | [`reader-api/v1`](../contracts/reader-api/v1/openapi.yaml) | Yes: draft.11, 55 replayable cases | **Passing at draft.11**, in its own CI job (see below), with three strict expected failures and one case not applicable | In progress: [`reader-backend/`](../reader-backend/README.md) is a facade over session-lookup and core ports; it passes the cases with fake adapters only, in its own CI job. Both HTTP adapters are merged (`HttpSessionLookup` and `HttpReaderCore`, which serve REST and SSE to the Reader and reach the core over the two contracts below); they have run only against fakes and a stub. No public core implementation exists, and an interop run against the reference Backend's reader-core is pending | No: not deployed anywhere |
| USB Connector | [`connector/v1`](../contracts/connector/v1/README.md), [`connector-hold/v1`](../contracts/connector-hold/v1/README.md) | Yes: wire contracts and fixtures | Not applicable: there is no private Connector | [`connector/`](../connector/README.md): passes its unit, fake-device and broker integration tests; the hold contract is at draft.4 and the MQTT contract at draft.2: a `busy` or `failed` answer to the gate's `deployment.get` is classified, not read as "not provisioned" (released in v0.9.5), and a stop during a serial DFU transfer ends on a whole frame and closes the port (v0.9.6). No deployed Connector is claimed to run those releases. Known limitation: see below | No |
| Observation reads | [`observations/v1`](../contracts/observations/v1/openapi.yaml) | Draft.4 (`observer_id` is scoped to the caller; observations are direct receptions only, and null means not reported): schemas, fixtures and 14 replayable cases ([`cases/`](../contracts/observations/v1/cases/README.md)) | Replays the cases in its own CI (reported by the reference's maintainers; the pinned commit and counts are not recorded here) | **Passing**: [`reader-backend/`](../reader-backend/README.md) serves observations/v1; all 14 published cases pass, 14 of 14, none skipped, in its CI job | No |
| Observation capture | [`observation-subscription/v1`](../contracts/observation-subscription/v1/README.md), [`raw-capture/v1`](../contracts/raw-capture/v1/README.md) | Drafts: raw capture draft.3, subscription draft.2; schemas and 10 fixtures | **Replay merged** in the private reference Backend for both (raw capture draft.3, subscription draft.2) | **Passing**: [`capture/`](../capture/README.md) replays all 10 published fixtures (raw capture A to F, subscription A to D), 10 of 10, in its own CI job | **No. Shadow trial only, no parity evidence** (see below) |
| Observation processing | [`observation-processing/v1`](../contracts/observation-processing/v1/README.md) | Draft (`1.0.0-draft.1`): schemas, replayable fixtures and a reference processor | **Replay merged** in the private reference Backend, pinned at commit 20b3f3b | **Passing**: [`processing/`](../processing/README.md) replays all 5 published fixtures (A to E, the crash step included), 5 of 5, in its own CI job | No |
| Session lookup | [`session-lookup/v1`](../contracts/session-lookup/v1/openapi.yaml) | Draft (`1.0.0-draft.3`, adds 422 `malformed_request` and the base-path line): schemas, fixtures and 20 replayable cases ([`cases/`](../contracts/session-lookup/v1/cases/README.md)); cache timing, stream close on revocation and feed-down closing are not replayable and need implementation tests | Replays the cases in its own CI (reported by the reference's maintainers; the pinned commit and counts are not recorded here) | HTTP adapter merged in `reader-backend/`; fakes and a stub only, no interop run against a real core | No |
| Reader core | [`reader-core/v1`](../contracts/reader-core/v1/openapi.yaml) | Draft.2 (after a core implementer's review): one operation per `ReaderCore` port method, fixtures and 49 replayable cases ([`cases/`](../contracts/reader-core/v1/cases/README.md)) | Replays the cases in its own CI (reported by the reference's maintainers; the pinned commit and counts are not recorded here); an interop run of the facade's adapter against it is pending | [`reader-backend/`](../reader-backend/README.md): the fake core and a stub core pass the cases (49 of 49 over HTTP; 43 of 49 on the fake, 6 not applicable to a Python port); the `HttpReaderCore` adapter is merged and has run only against that stub; no public core | No |
| Anonymous public map feed | [`public-map/v1`](../contracts/public-map/v1/openapi.yaml) | Draft (`1.0.0-draft.1`): the polled feed at `/api/public/v1` (`GET /nodes`, and `GET /events` with a `since` cursor; not SSE), 22 replayable cases ([`cases/`](../contracts/public-map/v1/cases/README.md)), synthetic fixtures and a case-checker mutation check | Replays the cases in its own CI (reported by the reference's maintainers; the pinned commit and counts are not recorded here) | Not started | No |
| Job lifecycle and device dispatch | [`job-lifecycle/v1`](../contracts/job-lifecycle/v1/README.md), [`device-dispatch/v1`](../contracts/device-dispatch/v1/README.md) | Draft: schemas, a typed command catalogue, 13 replayable fixtures (job lifecycle A to H and K, device dispatch I to L) and reference models; timing under load and real signing are not replayable and need implementation tests | **Replay merged** in the private reference Backend, pinned at commit fd339c8: every fixture case replayed against its own request and job code in its CI shards, with the cases it cannot express skipped as not applicable and each known gap held as a strict expected failure, per case | Not started | No |

## Reader API, stage 2

The private Backend vendors `contracts/reader-api/v1` at draft.11 and replays each case in a dedicated CI job, which its server test gate requires. Its results at draft.11, 55 cases:

- **51 cases pass.**
- **1 case is not applicable** (`leases-04`): it covers a Backend that offers no offline leases, and this one always offers them.
- **3 cases are strict expected failures:**
  - `session-15` and `session-16`: during a session-lookup outage the reference Backend answers an error (500) instead of the contract's 503 `unavailable`.
  - `messaging-12`: private channel names. The contract makes them unique within a fleet, but the reference Backend still makes them unique across the instance. The decision is taken and the change is pending.

Each expected failure is marked so that the job fails once the case starts passing unannounced.

Earlier, at draft.10, the replay found that the login request accepted unknown body fields that the contract forbids; that is fixed, and production has refused such a request with 422 since 2026-11-22.

## Observation capture: shadow trial

The public `capture/` service, release v0.9.2, has run since 2026-11-25 as a bounded 7-day shadow trial beside the hosted Backend. Its bounds:

- **Subscribe-only:** it holds a subscribe-only login and publishes nothing.
- **Time-bounded:** 7 days from 2026-11-25.
- **No cutover:** the hosted Backend remains the only capture path that serves users.

State so far: connected and subscribed, but it has received **no** observation traffic, because no observer publishes to that broker yet. There is therefore **no capture-parity evidence**. A connected subscriber is not parity, and the trial does not count as stage 4.

## Known limitation: serial DFU recovery

A serial DFU of an nRF52 device that is interrupted after data writing has begun (past the erase) can only be recovered by a UF2 copy, whatever the host and however cleanly the transfer stops. A later serial DFU may print success while the application never starts. UF2 is the accepted field recovery. From firmware v0.3.22 (a pre-release at the time of writing), releases carry a `recovery_uf2` asset for each nRF52 variant (listed in the release's update set). The Connector's clean stop (v0.9.6) avoids one way of interrupting a transfer; it does not make an interrupted one recoverable. The Connector does not yet detect or report that a device needs UF2 recovery: that is planned work, not shipped.
