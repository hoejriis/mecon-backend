# Live observation API — target v1

This describes a **target**, not a currently available endpoint. It enables an anonymous public activity map and separately authorized diagnostic clients without exposing private Backend internals.

## Architecture and transport

A Backend normalizes packet reception evidence from permitted sources. It exposes two **separate projections** over that model, with independent authorization, retention and response schemas:

- `/api/observations/v1/public`: anonymous, approved public catalogue, snapshot and bounded SSE activity.
- `/api/observations/v1/authorized`: session-authenticated, capability-scoped fleet/user diagnostic catalogue, snapshot and SSE activity.

No client connects directly to MQTT, storage or raw ingress. Use HTTPS JSON REST snapshots and SSE subscriptions. The public map never calls the authorized endpoints.

## Public projection

- `GET /public/nodes`: approved public nodes only, with `public_id`, display label, approved coarse location or region (nullable), and publication freshness.
- `GET /public/snapshot`: bounded approved activity summary and `cursor`, `as_of`, `expires_at`.
- `GET /public/events?cursor=`: SSE event `{event_id,kind,public_node_id,occurred_at,expires_at,activity_class,region?,cursor}`.
- Publication is **deny by default**: node/source owner approval, consent, permitted redistribution and revocation are prerequisites. Coarsen or omit coordinates when disclosure would identify a private location. Do not publish unapproved sender/observer IDs, exact private positions, payload, packet hashes, private channel/identity, RSSI/SNR, RF route, internal source names or endpoints.
- No public event represents a proven end-to-end RF route unless that exact claim is independently evidenced and approved; otherwise present only observed activity. Public event IDs must not be linkable to private event IDs.
- Bound public history, frequency, per-node activity and rate to reduce tracking. The server defines and documents conservative TTL and aggregation thresholds before enabling a live feed. Consent revocation invalidates current snapshots/cursors and removes affected public data. The site must not replay expired events as live.
- Synthetic fixtures are prominently marked as demonstration, never as real traffic.

## Authorized projection

- `GET /authorized/snapshot?scope=&cursor=` and `GET /authorized/events?scope=&cursor=` require a session and server-side capability checks on **every** request and reconnect.
- Authorized event fields may include `event_id`, `packet_correlation_id`, `reception_id`, `observer_id`, `observed_at`, `received_at`, `clock_confidence`, `transport`, `packet_kind`, `rssi`, `snr`, `provenance` and `inference_level`, only where the user's scope permits. Each reception has a distinct ID; correlated receptions may share a packet correlation ID without implying a known route.
- Authorization to operate a fleet or Backend does **not** imply permission to decrypt another user's private messages. No decrypted plaintext in the observation feed. Limit raw packet bytes to a separate, explicitly authorized future contract if ever required.
- Optional bounded capture subscriptions require a distinct capability, expiry, rate limits and audit events.

## Stream and failure semantics

Snapshots and SSE events carry opaque scoped cursors, event IDs, UTC timestamps, schema version and source freshness. Clients deduplicate by event ID, reconnect using the last cursor, and fetch a fresh snapshot when the cursor expires, falls outside retention or access changes. Delivery is at least once while a cursor is valid; no global ordering or completeness guarantee. Emit heartbeat, `resync_required` and `access_revoked` signals as appropriate. Set explicit server-side stream and memory bounds, backpressure, per-client concurrency and rate limits before rollout. HTTP errors: 401, 403, 404, 410 (expired cursor), 429, 503.

## Acceptance and safety

Publish sanitized OpenAPI/AsyncAPI schemas and synthetic fixtures for public, authorized, empty, expired, duplicate, delayed, multi-observer and revoked states. Test consent withdrawal, observer/identity inference, cross-fleet authorization, private-location suppression, dedup, reconnect, clock skew and sustained load. Public UI must degrade safely to a static explanation or clearly labeled synthetic preview when the approved feed is unavailable. Production enablement and performance thresholds require independent acceptance; this specification does not authorize public data publication.
