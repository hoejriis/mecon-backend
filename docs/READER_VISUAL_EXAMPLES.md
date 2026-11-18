# Reader MVP1 — visual UX examples

> **Normative baseline (17 November 2026):** [MVP1 implementation design](MVP1_IMPLEMENTATION_DESIGN.md) governs milestone order, navigation, privacy, map, restricted deployment and acceptance. Real hardware and Backend API conformance still require verification.

**Status:** illustrative reference mockups, **not** implemented UI or an approved pixel-perfect design. Data, device names and counts are fictitious. Any mockup illustrates the approved five-tab Device User navigation and the live packet observation starting point. The separate Fleet Owner/Admin GUI is deferred, web-only work.

## MC1 screen references and MECON branded concept

Primary visual inspiration is [MeshCore One's App Store listing and screenshots](https://apps.apple.com/app/meshcore-one/id6757419477) and its [feature overview](https://github.com/Avi0n/MeshCoreOne). Concept screens are **illustrative only** and not part of this repository. Do not infer implementation, real telemetry, approved locations or verified device capabilities from illustrative screenshots. The normative design, real brand SVGs and privacy restrictions override mockups. Web Reader stays React/TypeScript under Apache-2.0; do not copy GPLv3 MC1 app source or protected assets.

## Design constraints for the coder

- **Brand authority:** [MeshContinuum brand specification](https://github.com/hoejriis/MeshContinuum/blob/main/docs/BRAND.md). Use **actual** original SVGs from [MeshContinuum/brand](https://github.com/hoejriis/MeshContinuum/tree/main/brand), especially `lockup-dark.svg` / `lockup-light.svg`. Never approximate or redraw the mark; mockups that use text in place of a logo are not logo references.
- Colours: navy `#0D1736`, turquoise `#25D6C9`, violet `#8B7CFF`, light `#F5F7FB`; dark surfaces `#0A1230` and `#131D45`. Respect documented contrast requirements.
- **All viewports:** persistent bottom **Chats / Nodes / Map / Tools / Settings**, with Channels within Chats. MC1's light mobile interface is the primary reference.
- **Map starts with live packet observations**, using authorized observation sources and public/role-scoped projections as appropriate. Show reception **at actual observer locations** and truthful RF metadata. Never infer transmitter location or draw a packet route from hearing alone. Respect privacy and observation-source publication rules; show empty/unavailable states.
- **Fleet/Admin:** management GUI is deferred to later web-only design; not a Device User bottom tab.
- This mockup is **not** evidence that Bluefy, packet map, RF metrics, fleet device counts or live APIs have been implemented.

## Related

- [Reader interaction specification](READER_UX.md)
- [MVP1 implementation design](MVP1_IMPLEMENTATION_DESIGN.md)
- [Live observation API contract](LIVE_OBSERVATION_API_CONTRACT.md)
- [Architecture Decision Register](ARCHITECTURE_DECISIONS.md)

**Source of truth:** the normative documents override any illustrative screen details.
