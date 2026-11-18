// Bundled to one script by the Playwright suite and injected with addInitScript
// before the page loads. Installs a fake navigator.serial and exposes it as
// window.__serial. SIMULATED. Which device sits on the port is chosen by
// window.__SERIAL_SIM ({ device, options }) set earlier by the test.
import { MockCompanion } from '../../ble/mockCompanion';
import { installFakeSerial } from './fakeSerial';
import { CompanionSerialPeer, MockRepeater, MockSilentDevice, type SerialPeer } from './serialPeers';

interface SimSpec {
  device?: 'companion' | 'stock-companion' | 'repeater' | 'stock-repeater' | 'room' | 'sensor' | 'silent' | 'misleading-board';
  options?: Record<string, unknown>;
  companion?: ConstructorParameters<typeof MockCompanion>[0];
}
const w = window as unknown as { __SERIAL_SIM?: SimSpec; __serial?: unknown; __peer?: SerialPeer; __mock?: MockCompanion };
const spec = w.__SERIAL_SIM ?? {};
let peer: SerialPeer;
switch (spec.device ?? 'companion') {
  case 'stock-companion': {
    const mock = new MockCompanion(spec.companion);
    w.__mock = mock;
    peer = new CompanionSerialPeer(mock, { mecon: false });
    break;
  }
  case 'repeater':
    peer = new MockRepeater({ ...spec.options, role: 'repeater' });
    break;
  case 'room':
    peer = new MockRepeater({ ...spec.options, role: 'room' });
    break;
  case 'sensor':
    peer = new MockRepeater({ ...spec.options, mecon: false, role: 'sensor' });
    break;
  case 'stock-repeater':
    peer = new MockRepeater({ ...spec.options, mecon: false, role: 'repeater' });
    break;
  case 'misleading-board':
    peer = new MockRepeater({ mecon: false, boardName: 'Acme Repeater Board', roleReply: null });
    break;
  case 'silent':
    peer = new MockSilentDevice('boot: hello world\r\n');
    break;
  default: {
    const mock = new MockCompanion(spec.companion);
    w.__mock = mock;
    peer = new CompanionSerialPeer(mock, { mecon: true });
  }
}
w.__peer = peer;
w.__serial = installFakeSerial(navigator, peer);
