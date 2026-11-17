# MECON Backend & Reader

The public application architecture for [MeshContinuum (MECON)](https://github.com/hoejriis/MeshContinuum): a familiar MeshCore messaging Reader, fleet operations, observation history and a self-hostable Backend for individuals and small communities.

> **Status — design, 17 November 2026:** The complete product target is documented here. **The first implementation programme is MVP1: the Bluefy-enabled Device User Reader GUI.** The remaining full-product work is now decomposed into separately scoped future issues. No public Backend application or Reader code is shipped yet. MVP1 connects to the existing private MECON Backend; its code, issues and operational details are not public and are deliberately not linked from this repository.

## Start with the product

- [Overall target architecture](docs/TARGET_ARCHITECTURE.md)
- [User experience — messaging and Companions](docs/USER_EXPERIENCE.md)
- [Fleet Owner experience — devices, assignments, sharing](docs/FLEET_OWNER_EXPERIENCE.md)
- [Instance Administrator experience — infrastructure and accounts](docs/ADMIN_EXPERIENCE.md)
- [Roles and GUI permissions](docs/ROLES_AND_PERMISSIONS.md)
- [Security and privacy](docs/SECURITY_AND_PRIVACY.md)

## Understand the system

- [Components and contracts](docs/COMPONENTS.md)
- [Deployment models, multi-site operation and recovery](docs/DEPLOYMENTS.md)
- [Roadmap — active MVP versus future target](docs/ROADMAP.md)

## Current work: MVP1 Reader GUI

A Bluefy-first web Reader for iPhone/iPad Device Users, with familiar **Chats, Channels, Contacts, Companion and Settings**, MECON's original colors/mark, BLE connection to a supported Companion and authorized online history/messaging through the existing private Backend. Familiar to users of the stock MeshCore app, but not a copy. Bluefy and hardware compatibility are **not yet verified**.

- [MVP product vision](docs/PRODUCT_VISION.md)
- [Reader interaction specification](docs/READER_UX.md)
- [BLE and private Backend MVP integration](docs/MVP1_ARCHITECTURE.md)
- [MVP delivery plan and acceptance](docs/MVP1_PLAN.md)
- [Active MVP issues](https://github.com/hoejriis/mecon-backend/issues)

**Issue sequencing:** Reader MVP issues #1–#7 are P3; full replacement issues #9–#29 are P5 and Needs Design. The latter describe independently deliverable future work and are not authorization to start implementation before the MVP. Issue #8 is closed as superseded by the granular backlog.

## Related public repositories

- [MeshContinuum](https://github.com/hoejriis/MeshContinuum) — product story, branding, roadmap, hosted-beta context and public-facing documentation.
- [mecon-firmware](https://github.com/hoejriis/mecon-firmware) — independent managed-device firmware and contracts, hardware evidence and releases.

MECON is independent of [MeshCore](https://github.com/meshcore-dev/MeshCore); no official affiliation is implied. Do not publish keys, private messages, production addresses, credentials or sensitive deployment information in issues.
