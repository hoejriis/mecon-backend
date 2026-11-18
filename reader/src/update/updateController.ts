import { hasBlockers, type Blockers } from './guards';

export type ConfirmMode = 'activate' | 'reload' | 'repair';

export interface UpdateState {
  /** A new version is downloaded and waiting for the user. */
  waiting: boolean;
  /** Another tab already activated a new version; this tab still runs the old one. */
  updatedElsewhere: boolean;
  /** Stale-shell repair found nothing to repair with a waiting worker; the user must confirm a hard repair. */
  repairPending: boolean;
  activating: boolean;
  /** Set while the user is asked to confirm; lists what would be lost. */
  confirm: { mode: ConfirmMode; blockers: Blockers } | null;
}

export interface UpdateChannel {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', cb: (e: { data: unknown }) => void): void;
  removeEventListener(type: 'message', cb: (e: { data: unknown }) => void): void;
  close(): void;
}

export interface UpdateDeps {
  container: {
    controller: unknown;
    addEventListener(type: 'controllerchange', cb: () => void): void;
    removeEventListener(type: 'controllerchange', cb: () => void): void;
  };
  registration: {
    waiting: { postMessage(m: unknown): void } | null;
    installing: { state: string; addEventListener(t: 'statechange', cb: () => void): void } | null;
    addEventListener(type: 'updatefound', cb: () => void): void;
    removeEventListener(type: 'updatefound', cb: () => void): void;
  };
  channel: UpdateChannel | null;
  getBlockers: () => Blockers;
  reload: () => void;
  /** Stale-shell hard repair (unregister, drop caches, reload), used when no waiting worker exists. */
  hardRepair?: () => Promise<void>;
}

export const CHANNEL_NAME = 'mecon-reader-update';

const same = (a: Blockers, b: Blockers) =>
  a.drafts === b.drafts && a.uncertainAttempts === b.uncertainAttempts && a.bleConnected === b.bleConnected;

/**
 * The update lifecycle for one tab. Activating a waiting version needs a user
 * tap, and a tap that would lose drafts, interrupt uncertain attempts or close
 * a BLE link first needs an explicit confirmation. Nothing here ever sends.
 */
export class UpdateController {
  private state: UpdateState = {
    waiting: false,
    updatedElsewhere: false,
    repairPending: false,
    activating: false,
    confirm: null,
  };
  private listeners = new Set<() => void>();
  private hadController: boolean;
  private reloaded = false;
  private stopFns: Array<() => void> = [];

  constructor(private deps: UpdateDeps) {
    this.hadController = !!deps.container.controller;
  }

  getState = (): UpdateState => this.state;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  };

  private set(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  start(): void {
    const { container, registration, channel } = this.deps;
    const refresh = () => this.set({ waiting: !!registration.waiting && !!container.controller && !this.state.updatedElsewhere });
    refresh();

    const onFound = () => {
      const w = registration.installing;
      w?.addEventListener('statechange', refresh);
      refresh();
    };
    registration.addEventListener('updatefound', onFound);
    this.stopFns.push(() => registration.removeEventListener('updatefound', onFound));

    const onChange = () => {
      if (!this.hadController) {
        this.hadController = true; // first install claiming the page is not an update
        return;
      }
      if (this.state.activating) {
        channel?.postMessage({ type: 'activated' });
        this.reloadOnce();
      } else {
        this.markUpdatedElsewhere();
      }
    };
    container.addEventListener('controllerchange', onChange);
    this.stopFns.push(() => container.removeEventListener('controllerchange', onChange));

    if (channel) {
      const onMsg = (e: { data: unknown }) => {
        const d = e.data as { type?: unknown } | null;
        if (d && d.type === 'activated' && !this.state.activating) this.markUpdatedElsewhere();
      };
      channel.addEventListener('message', onMsg);
      this.stopFns.push(() => channel.removeEventListener('message', onMsg));
    }
  }

  stop(): void {
    for (const f of this.stopFns.splice(0)) f();
    this.deps.channel?.close();
  }

  private markUpdatedElsewhere() {
    this.set({ updatedElsewhere: true, waiting: false, confirm: null });
  }

  private reloadOnce() {
    if (this.reloaded) return;
    this.reloaded = true;
    this.deps.reload();
  }

  /** Called by the stale-shell check when it found a newer build but must not repair silently. */
  noteStaleBlocked(): void {
    if (!this.state.waiting) this.set({ repairPending: true });
  }

  /** Activate the waiting worker now (used by the stale-shell repair when nothing is at risk). */
  activateWaiting(): boolean {
    const w = this.deps.registration.waiting;
    if (!w || !this.deps.container.controller) return false;
    this.set({ activating: true, confirm: null });
    w.postMessage({ type: 'SKIP_WAITING' });
    return true;
  }

  /** The user tapped the banner's main button. */
  requestUpdate(): 'confirm' | 'started' | 'nothing' {
    const s = this.state;
    const mode: ConfirmMode | null = s.updatedElsewhere ? 'reload' : s.waiting ? 'activate' : s.repairPending ? 'repair' : null;
    if (!mode) return 'nothing';
    const blockers = this.deps.getBlockers();
    if (hasBlockers(blockers)) {
      this.set({ confirm: { mode, blockers } });
      return 'confirm';
    }
    this.run(mode);
    return 'started';
  }

  /**
   * The user confirmed. If what is at risk changed since the confirmation was
   * shown (a new draft, a new attempt), show the new list instead of acting.
   */
  confirmUpdate(): 'started' | 'reconfirm' | 'nothing' {
    const c = this.state.confirm;
    if (!c) return 'nothing';
    const now = this.deps.getBlockers();
    if (hasBlockers(now) && !same(now, c.blockers)) {
      this.set({ confirm: { mode: c.mode, blockers: now } });
      return 'reconfirm';
    }
    this.set({ confirm: null });
    this.run(c.mode);
    return 'started';
  }

  cancelConfirm(): void {
    this.set({ confirm: null });
  }

  private run(mode: ConfirmMode) {
    if (mode === 'reload') {
      this.reloadOnce();
    } else if (mode === 'activate') {
      this.activateWaiting();
    } else {
      this.set({ activating: true });
      void this.deps.hardRepair?.();
    }
  }
}
