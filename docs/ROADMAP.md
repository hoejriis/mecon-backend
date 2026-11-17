# Public application roadmap — target and active work

## Current active development scope: **MVP1 Device User Reader GUI only**

The only implementation issues currently open in this public repository should concern the **Bluefy-enabled Reader for Device Users**, its UX, BLE feasibility/adapter, private Backend compatibility, message journeys and acceptance. The Backend is **not being rebuilt in MVP1**. Fleet Owner/Admin screens, federation, deployment packaging, advanced offline cache and new public Backend code are **documented targets only**; do not create implementation issues for them until a subsequent phase is authorized.

### MVP1 gates

1. Bluefy/iPhone/iPad real-device BLE protocol evidence.
2. MECON-branded, stock-MeshCore-familiar Reader navigation and flows.
3. Versioned private Backend compatibility contract for account, authorized messages and send outcomes.
4. React Reader shell and BLE adapter; direct BLE and online paths explicitly distinguished.
5. End-to-end chats, channels, contacts, Companion selection and honest send status.
6. Privacy and hardware acceptance; existing private Backend and Reader unaffected.

See [MVP1 plan](MVP1_PLAN.md) and [active MVP1 issues](https://github.com/hoejriis/mecon-backend/issues).

## Later target increments — documentation only

- Fleet Owner inventory, assignment, configuration, diagnostics and observation-sharing GUI.
- Admin deployment, accounts, public observation sources, infrastructure and health GUI.
- Local encrypted offline Reader cache, authorization lease, safe synchronization and direct BLE/USB workflows beyond MVP1.
- Public Python/FastAPI Backend, served Reader, SQLite, Mosquitto and USB Connector deployment packaging.
- Multi-Backend Join, continuity, federation and cold recovery; migration from private service.
- Independent-operator and hardware acceptance, security review and public release.

These are **not current MVP1 commitments**. See [target architecture](TARGET_ARCHITECTURE.md), [deployments](DEPLOYMENTS.md) and [roles](ROLES_AND_PERMISSIONS.md).
