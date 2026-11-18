// Bundled to a single script by the Playwright suite and injected with
// addInitScript before the page loads. Installs a fake navigator.bluetooth
// backed by a MockCompanion and exposes it as window.__ble. SIMULATED.
import { installFakeBluetooth } from './fakeBluetooth';
import { MockCompanion } from './mockCompanion';

const w = window as unknown as { __BLE_SIM_OPTS?: ConstructorParameters<typeof MockCompanion>[0]; __ble?: unknown };
w.__ble = installFakeBluetooth(navigator, new MockCompanion(w.__BLE_SIM_OPTS));
