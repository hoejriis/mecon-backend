import { NO_BLOCKERS, type Blockers } from './guards';
import { UpdateController, type UpdateDeps } from './updateController';

class Target {
  private l = new Map<string, Set<(e?: never) => void>>();
  addEventListener(t: string, cb: (e?: never) => void) {
    if (!this.l.has(t)) this.l.set(t, new Set());
    this.l.get(t)!.add(cb);
  }
  removeEventListener(t: string, cb: (e?: never) => void) {
    this.l.get(t)?.delete(cb);
  }
  emit(t: string, e?: unknown) {
    for (const cb of [...(this.l.get(t) ?? [])]) (cb as (e?: unknown) => void)(e);
  }
}

/** A BroadcastChannel stand-in: messages reach every OTHER member of the same bus. */
class Bus {
  members: Chan[] = [];
}
class Chan extends Target {
  closed = false;
  constructor(private bus: Bus) {
    super();
    bus.members.push(this);
  }
  postMessage(data: unknown) {
    for (const m of this.bus.members) if (m !== this && !m.closed) m.emit('message', { data });
  }
  close() {
    this.closed = true;
  }
}

function tab(bus: Bus, over: { blockers?: () => Blockers; controller?: boolean; waiting?: boolean } = {}) {
  const container = Object.assign(new Target(), { controller: over.controller === false ? null : {} });
  const posted: unknown[] = [];
  const registration = Object.assign(new Target(), {
    waiting: over.waiting === false ? null : { postMessage: (m: unknown) => posted.push(m) },
    installing: null as null | (Target & { state: string }),
  });
  const reload = vi.fn();
  const hardRepair = vi.fn(async () => undefined);
  let blockers = over.blockers ?? (() => NO_BLOCKERS);
  const deps = {
    container,
    registration,
    channel: new Chan(bus),
    getBlockers: () => blockers(),
    reload,
    hardRepair,
  } as unknown as UpdateDeps;
  const c = new UpdateController(deps);
  c.start();
  return { c, container, registration, posted, reload, hardRepair, setBlockers: (f: () => Blockers) => (blockers = f) };
}

const drafts = (n = 1): Blockers => ({ ...NO_BLOCKERS, drafts: n });

describe('UpdateController', () => {
  it('a waiting worker is announced, never activated by itself', () => {
    const t = tab(new Bus());
    expect(t.c.getState().waiting).toBe(true);
    expect(t.posted).toEqual([]);
    expect(t.reload).not.toHaveBeenCalled();
  });

  it('a worker that installs later becomes waiting only once installed and a controller exists', () => {
    const t = tab(new Bus(), { waiting: false });
    expect(t.c.getState().waiting).toBe(false);
    const installing = Object.assign(new Target(), { state: 'installing' });
    t.registration.installing = installing;
    t.registration.emit('updatefound');
    t.registration.waiting = { postMessage: (m: unknown) => t.posted.push(m) };
    installing.state = 'installed';
    installing.emit('statechange');
    expect(t.c.getState().waiting).toBe(true);
    expect(t.posted).toEqual([]);
  });

  it('first install claiming an uncontrolled page is not an update and does not reload', () => {
    const t = tab(new Bus(), { controller: false, waiting: false });
    t.container.emit('controllerchange');
    expect(t.c.getState().updatedElsewhere).toBe(false);
    expect(t.reload).not.toHaveBeenCalled();
  });

  it('with nothing at risk, one tap sends SKIP_WAITING and the controllerchange reloads exactly once', () => {
    const t = tab(new Bus());
    expect(t.c.requestUpdate()).toBe('started');
    expect(t.posted).toEqual([{ type: 'SKIP_WAITING' }]);
    expect(t.reload).not.toHaveBeenCalled(); // waits for the new worker to take over
    t.container.emit('controllerchange');
    t.container.emit('controllerchange');
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['drafts', drafts(2)],
    ['uncertain attempts', { ...NO_BLOCKERS, uncertainAttempts: 1 }],
    ['a BLE connection', { ...NO_BLOCKERS, bleConnected: true }],
  ])('%s: the tap asks first and activates nothing until confirmed', (_n, b) => {
    const t = tab(new Bus(), { blockers: () => b });
    expect(t.c.requestUpdate()).toBe('confirm');
    expect(t.c.getState().confirm).toEqual({ mode: 'activate', blockers: b });
    expect(t.posted).toEqual([]);
    t.c.cancelConfirm();
    expect(t.c.getState().confirm).toBeNull();
    expect(t.posted).toEqual([]);
    t.c.requestUpdate();
    expect(t.c.confirmUpdate()).toBe('started');
    expect(t.posted).toEqual([{ type: 'SKIP_WAITING' }]);
  });

  it('a blocker that appears between the prompt and the confirm shows a new prompt instead of activating', () => {
    let b = drafts(1);
    const t = tab(new Bus(), { blockers: () => b });
    t.c.requestUpdate();
    b = { ...b, uncertainAttempts: 1 };
    expect(t.c.confirmUpdate()).toBe('reconfirm');
    expect(t.posted).toEqual([]);
    expect(t.c.getState().confirm?.blockers.uncertainAttempts).toBe(1);
    expect(t.c.confirmUpdate()).toBe('started');
    expect(t.posted).toHaveLength(1);
  });

  it('confirmUpdate without a prompt does nothing', () => {
    const t = tab(new Bus());
    expect(t.c.confirmUpdate()).toBe('nothing');
    expect(t.posted).toEqual([]);
  });

  it('activation in one tab marks the other tab updated-elsewhere and it does NOT reload', () => {
    const bus = new Bus();
    const a = tab(bus);
    const b = tab(bus, { blockers: () => drafts() });
    a.c.requestUpdate();
    a.container.emit('controllerchange'); // tab A took over and reloads
    b.container.emit('controllerchange'); // the browser also tells tab B
    expect(a.reload).toHaveBeenCalledTimes(1);
    expect(b.c.getState().updatedElsewhere).toBe(true);
    expect(b.c.getState().waiting).toBe(false);
    expect(b.reload).not.toHaveBeenCalled();
  });

  it('the BroadcastChannel message alone is enough to tell another tab', () => {
    const bus = new Bus();
    const a = tab(bus);
    const b = tab(bus);
    a.c.requestUpdate();
    a.container.emit('controllerchange'); // only A's event; B hears via the channel
    expect(b.c.getState().updatedElsewhere).toBe(true);
    expect(b.reload).not.toHaveBeenCalled();
  });

  it('an updated-elsewhere tab with drafts reloads only after an explicit confirmation', () => {
    const bus = new Bus();
    const a = tab(bus);
    const b = tab(bus, { blockers: () => drafts() });
    a.c.requestUpdate();
    a.container.emit('controllerchange');
    expect(b.c.requestUpdate()).toBe('confirm');
    expect(b.c.getState().confirm?.mode).toBe('reload');
    expect(b.reload).not.toHaveBeenCalled();
    b.c.confirmUpdate();
    expect(b.reload).toHaveBeenCalledTimes(1);
  });

  it('an updated-elsewhere tab with nothing at risk reloads on its own tap', () => {
    const bus = new Bus();
    const a = tab(bus);
    const b = tab(bus);
    a.c.requestUpdate();
    a.container.emit('controllerchange');
    expect(b.c.requestUpdate()).toBe('started');
    expect(b.reload).toHaveBeenCalledTimes(1);
  });

  it('stale-shell blocked with no waiting worker: banner path asks, then hard-repairs on confirm', () => {
    const t = tab(new Bus(), { waiting: false, blockers: () => drafts() });
    t.c.noteStaleBlocked();
    expect(t.c.getState().repairPending).toBe(true);
    expect(t.c.requestUpdate()).toBe('confirm');
    expect(t.hardRepair).not.toHaveBeenCalled();
    t.c.confirmUpdate();
    expect(t.hardRepair).toHaveBeenCalledTimes(1);
  });

  it('activateWaiting refuses when there is no waiting worker', () => {
    const t = tab(new Bus(), { waiting: false });
    expect(t.c.activateWaiting()).toBe(false);
  });
});
