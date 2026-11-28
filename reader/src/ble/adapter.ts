import {
  APP_TARGET_VERSION,
  FrameEncodeError,
  KEY_PREFIX_SIZE,
  decodeFrame,
  encodeAppStart,
  encodeDeviceQuery,
  encodeGetContacts,
  encodeSendChannel,
  encodeSendDirect,
  encodeSyncNextMessage,
  isChannelSendAccepted,
  type Contact,
  type DeviceInfo,
  type Frame,
  type IncomingChannelMessage,
  type IncomingDirectMessage,
  type SelfInfo,
} from './protocol';
import { BleError, type BleDeviceInfo, type BleErrorCode, type CompanionTransport, type DisconnectReason, type TransportKind } from './transport';

/**
 * Truthful Companion state for the Reader, over BLE or USB (the transport's
 * `kind`; every attempt records it as `path`). The adapter is transport-neutral:
 * the same facts and the same send-safety rules apply on both, and an attempt is
 * never moved from one transport to the other or to the Backend. (The names
 * `BleAdapter`, `bleConnection` and `BleSnapshot` predate USB and are kept so
 * existing code and tests do not change.)
 * Every fact below is its own observation and
 * is NEVER inferred from another one:
 *
 *  - bleConnection:  what the link (GATT or serial port) is doing right now.
 *  - deviceAccepted: the Companion answered the command with an accepting frame.
 *                    It is not evidence that anything went out over the radio.
 *  - rfTransmitted:  evidence the radio transmitted. The protocol subset used here
 *                    has no frame that carries such evidence, so this stays false
 *                    ("not observed") unless recordRfTransmitEvidence() is called.
 *                    Native Companion frames carry no RF evidence (Issue #5); only the
 *                    interface's 0x7F message frames over a trusted link would.
 *  - dmAck:          the recipient's native ACK (PUSH_CODE_SEND_CONFIRMED) for this
 *                    attempt's tag. Not a read receipt. Channel sends never get one.
 *  - unknown:        the outcome of the write is not known (link lost, timeout or
 *                    write error after the frame may have reached the device). It
 *                    never means "failed": the device may have transmitted.
 *
 * A `false` fact means "not observed", never "observed not to have happened".
 *
 * Send safety: an attempt is written at most once. After `unknown` it is never
 * resent over BLE and never handed to the Backend; the user must start a new
 * attempt with a new client_attempt_id.
 *
 * Nothing is persisted by this module: no storage API is used and no key material
 * is held (public keys of contacts only, in memory).
 */
/**
 * Link states. `busy` and `unplugged` occur on USB only: `busy` is a chosen port
 * that is already open elsewhere; `unplugged` is the browser's `disconnect`
 * event for the port (cable pulled, board reset, or permission revoked: the
 * browser does not say which).
 */
export type LinkState = 'unsupported' | 'idle' | 'requesting' | 'connected' | 'disconnected' | 'denied' | 'busy' | 'unplugged';
export type BleConnection = LinkState;

export interface AttemptFacts {
  clientDraftId: string;
  clientAttemptId: string;
  /** The transport this attempt was (or would have been) written to. Never changes. */
  path: TransportKind;
  kind: 'direct' | 'channel';
  /** Hex key prefix (direct) or channel index as text (channel). */
  target: string;
  /** True once the write was handed to the transport. Never goes back to false. */
  writeIssued: boolean;
  /** True when the attempt was never written (refused, or link lost while queued). */
  notSent: boolean;
  deviceAccepted: boolean;
  rfTransmitted: boolean;
  dmAck: boolean;
  /** The device's suggested ACK window passed with no ACK. Not proof of non-delivery. */
  ackTimedOut: boolean;
  unknown: boolean;
  /** Set when the device answered with an error frame (definitely not accepted). */
  deviceError: { code: number | null; name: string } | null;
  reason: string | null;
}

export type InboxMessage =
  | { kind: 'direct'; message: IncomingDirectMessage }
  | { kind: 'channel'; message: IncomingChannelMessage };

export interface BleSnapshot {
  /** Which transport this adapter drives. */
  transportKind: TransportKind;
  bleConnection: LinkState;
  device: BleDeviceInfo | null;
  /** True once hello (app start, device query) completed on this link. */
  helloComplete: boolean;
  /**
   * The contact list is read after the connection is up, in the background (its size grows with the
   * contact count). `loading`: being read; `loaded`: `contacts` is complete; `failed`: the read
   * stopped (the link stays up). Anything that needs a contact waits for `loaded`.
   */
  contactsState: 'idle' | 'loading' | 'loaded' | 'failed';
  lastError: BleErrorCode | null;
  selfInfo: SelfInfo | null;
  deviceInfo: DeviceInfo | null;
  contacts: Contact[];
  inbox: InboxMessage[];
  attempts: AttemptFacts[];
}

/**
 * Stands for the Backend send path. The adapter never calls it. It exists so a
 * test can prove that an uncertain BLE send is not routed to the Backend.
 */
export interface BackendSendPort {
  post(attempt: AttemptFacts): Promise<void>;
}

export interface BleAdapterOptions {
  transport: CompanionTransport;
  responseTimeoutMs?: number;
  /** Bound on the write call itself. On some hosts the first write to the encrypted characteristic waits for the user to type the pairing PIN. */
  writeTimeoutMs?: number;
  connectTimeoutMs?: number;
  nowSec?: () => number;
  backendPath?: BackendSendPort;
}

export interface ConnectResult {
  ok: boolean;
  error: BleErrorCode | null;
}

interface Inflight {
  onFrame(f: Frame): 'done' | 'more' | 'ignore';
  finish(): void;
  fail(e: BleError): void;
}

export class BleAdapter {
  private readonly transport: CompanionTransport;
  private readonly responseTimeoutMs: number;
  private readonly writeTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly nowSec: () => number;
  private readonly backendPath: BackendSendPort | undefined;
  private snap: BleSnapshot;
  private listeners = new Set<() => void>();
  private inflight: Inflight | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private attemptIndex = new Map<string, AttemptFacts>();
  private tags = new Map<string, number>(); // clientAttemptId -> tag
  private seenTags = new Set<number>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private syncing = false;
  private offs: Array<() => void> = [];
  private linkEpoch = 0;
  /** Count of frames that matched nothing in flight (duplicates, late replies). Diagnostic only. */
  strayFrames = 0;

  constructor(opts: BleAdapterOptions) {
    this.transport = opts.transport;
    this.responseTimeoutMs = opts.responseTimeoutMs ?? 5000;
    this.writeTimeoutMs = opts.writeTimeoutMs ?? 60000;
    // As long as the probe (20 s): where the OS pairs during the GATT connect, this window includes the user typing the PIN.
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 20000;
    this.nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
    this.backendPath = opts.backendPath;
    this.snap = {
      transportKind: this.transport.kind,
      bleConnection: this.transport.support === 'supported' ? 'idle' : 'unsupported',
      device: null,
      helloComplete: false,
      contactsState: 'idle',
      lastError: null,
      selfInfo: null,
      deviceInfo: null,
      contacts: [],
      inbox: [],
      attempts: [],
    };
    this.offs.push(this.transport.onFrame((b) => this.handleBytes(b)));
    this.offs.push(this.transport.onDisconnect((reason) => this.handleDisconnect(reason)));
  }

  // -- store ---------------------------------------------------------------
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getSnapshot = (): BleSnapshot => this.snap;

  private set(patch: Partial<BleSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const l of [...this.listeners]) l();
  }

  private touchAttempt(a: AttemptFacts, patch: Partial<AttemptFacts>): void {
    Object.assign(a, patch);
    // The index holds the live object; snapshots carry copies.
    this.set({ attempts: this.snap.attempts.map((x) => (x.clientAttemptId === a.clientAttemptId ? { ...a } : x)) });
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const off of this.offs) off();
    this.offs = [];
    this.listeners.clear();
  }

  private timer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  private clear(t: ReturnType<typeof setTimeout>): void {
    clearTimeout(t);
    this.timers.delete(t);
  }

  // -- connection ----------------------------------------------------------
  /**
   * Opens the chooser and connects. Call it directly from a click handler: the
   * first thing it does is call transport.requestDevice(), with no await before.
   */
  connect(): Promise<ConnectResult> {
    const c = this.snap.bleConnection;
    if (c === 'unsupported') return Promise.resolve({ ok: false, error: 'unsupported' });
    if (c === 'requesting' || c === 'connected') return Promise.resolve({ ok: false, error: 'busy' });
    this.set({ bleConnection: 'requesting', lastError: null, helloComplete: false, contactsState: 'idle', contacts: [] });
    const chooser = this.transport.requestDevice();
    return this.afterChooser(chooser);
  }

  private async afterChooser(chooser: Promise<BleDeviceInfo>): Promise<ConnectResult> {
    let device: BleDeviceInfo;
    try {
      device = await chooser;
    } catch (e) {
      const code = e instanceof BleError ? e.code : 'connect_failed';
      const next: LinkState = code === 'permission_denied' || code === 'gesture_required' ? 'denied' : code === 'unsupported' ? 'unsupported' : 'idle';
      this.set({ bleConnection: next, lastError: code });
      return { ok: false, error: code };
    }
    this.set({ device });
    return this.link();
  }

  /** Reconnects to the device chosen earlier in this page's life. No chooser, no gesture needed. */
  reconnect(): Promise<ConnectResult> {
    const c = this.snap.bleConnection;
    if (c === 'connected' || c === 'requesting') return Promise.resolve({ ok: false, error: 'busy' });
    if (!this.snap.device) return Promise.resolve({ ok: false, error: 'not_connected' });
    this.set({ bleConnection: 'requesting', lastError: null, helloComplete: false, contactsState: 'idle', contacts: [] });
    return this.link();
  }

  private async link(): Promise<ConnectResult> {
    const epoch = ++this.linkEpoch;
    try {
      await this.withTimeout(this.transport.connect(), this.connectTimeoutMs, 'connect_timeout');
    } catch (e) {
      void this.transport.disconnect();
      const code = e instanceof BleError ? e.code : 'connect_failed';
      this.set({ bleConnection: code === 'port_busy' ? 'busy' : 'disconnected', lastError: code });
      return { ok: false, error: code };
    }
    if (epoch !== this.linkEpoch) return { ok: false, error: 'disconnected' };
    this.set({ bleConnection: 'connected' });
    try {
      await this.hello();
    } catch (e) {
      const code = e instanceof BleError ? e.code : 'device_error';
      if (this.snap.bleConnection === 'connected') {
        await this.transport.disconnect();
        this.set({ bleConnection: 'disconnected' });
      }
      this.set({ lastError: code });
      return { ok: false, error: code };
    }
    this.set({ helloComplete: true });
    // Connected. The contact list can take minutes on a slow link; it loads in the background.
    void this.loadContacts().catch(() => undefined);
    return { ok: true, error: null };
  }

  async disconnect(): Promise<void> {
    await this.transport.disconnect();
  }

  private handleDisconnect(reason?: DisconnectReason): void {
    this.linkEpoch++;
    const wasLive = this.snap.bleConnection === 'connected' || this.snap.bleConnection === 'requesting';
    if (wasLive) this.set({ bleConnection: reason === 'port_lost' ? 'unplugged' : 'disconnected', helloComplete: false, contactsState: 'idle' });
    const f = this.inflight;
    this.inflight = null;
    f?.fail(new BleError('disconnected'));
  }

  private withTimeout<T>(p: Promise<T>, ms: number, code: BleErrorCode, detail?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = this.timer(() => reject(new BleError(code, detail)), ms);
      p.then(
        (v) => {
          this.clear(t);
          resolve(v);
        },
        (e) => {
          this.clear(t);
          reject(e);
        },
      );
    });
  }

  // -- request/response ----------------------------------------------------
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Writes one frame and waits for its reply. Resolves with an error frame when
   * the device refused. Rejects with BleError on timeout, disconnect or write error.
   * `op` names the exchange in timeout errors and the console line.
   */
  private async exchange(op: string, frame: Uint8Array, onFrame: (f: Frame) => 'done' | 'more' | 'ignore'): Promise<Frame | null> {
    let error: Frame | null = null;
    let finish!: () => void;
    let fail!: (e: BleError) => void;
    const done = new Promise<void>((res, rej) => {
      finish = res;
      fail = rej;
    });
    done.catch(() => undefined);
    let t: ReturnType<typeof setTimeout> | undefined;
    // The reply bound is a silence bound: it restarts with every frame that belongs to the reply, so a
    // long multi-frame answer (the contact list) on a slow link is not cut off while frames keep arriving.
    const arm = (): void => {
      if (t !== undefined) this.clear(t);
      t = this.timer(() => {
        if (this.inflight === me) this.inflight = null;
        console.warn(`[reader] response_timeout: no answer to ${op} within ${this.responseTimeoutMs} ms`);
        fail(new BleError('response_timeout', `no answer to ${op}`));
      }, this.responseTimeoutMs);
    };
    const me: Inflight = {
      onFrame: (f) => {
        if (f.kind === 'error') {
          error = f;
          return 'done';
        }
        const v = onFrame(f);
        if (v === 'more' && t !== undefined) arm();
        return v;
      },
      finish,
      fail,
    };
    this.inflight = me;
    try {
      // The reply timer starts only once the write has returned: a write can stay
      // pending for a long time (the OS pairing prompt), and that wait is not the
      // device being slow to answer. The write has its own, longer bound.
      try {
        await this.withTimeout(this.transport.write(frame), this.writeTimeoutMs, 'write_timeout', `write of ${op} not completed (pairing not finished?)`);
      } catch (e) {
        if (e instanceof BleError && e.code === 'write_timeout') console.warn(`[reader] write_timeout during ${op} after ${this.writeTimeoutMs} ms`);
        throw e;
      }
      if (this.inflight === me) arm();
      await done;
    } finally {
      if (t !== undefined) this.clear(t);
      if (this.inflight === me) this.inflight = null;
    }
    return error;
  }

  private handleBytes(bytes: Uint8Array): void {
    const f = decodeFrame(bytes);
    // Pushes are never replies to a command.
    if (f.kind === 'sendConfirmed') return this.onSendConfirmed(f.tag);
    if (f.kind === 'messagesWaiting') {
      void this.syncMessages();
      return;
    }
    if (f.kind === 'advert' || f.kind === 'unknown' || f.kind === 'malformed') return;
    // A reply to a send that we already saw (same tag) is a duplicate notification.
    if (f.kind === 'sent' && this.seenTags.has(f.tag)) {
      this.strayFrames++;
      return;
    }
    const cur = this.inflight;
    if (!cur) {
      this.strayFrames++;
      return;
    }
    const v = cur.onFrame(f);
    if (v === 'done') {
      this.inflight = null;
      cur.finish();
    } else if (v === 'ignore') {
      this.strayFrames++;
    }
  }

  private onSendConfirmed(tag: number): void {
    for (const [attemptId, t] of this.tags) {
      if (t !== tag) continue;
      const a = this.attemptIndex.get(attemptId);
      if (a && a.kind === 'direct' && a.deviceAccepted && !a.dmAck) this.touchAttempt(a, { dmAck: true });
      return;
    }
    this.strayFrames++; // ACK for nothing we know: ignored, never matched by guess
  }

  // -- hello ---------------------------------------------------------------
  private async hello(): Promise<void> {
    await this.serial(async () => {
      await this.exchange('APP_START', encodeAppStart(), (f) => {
        if (f.kind !== 'selfInfo') return 'ignore';
        this.set({ selfInfo: f.info });
        return 'done';
      }).then((err) => this.mustNotBeError(err));
      await this.exchange('DEVICE_QUERY', encodeDeviceQuery(APP_TARGET_VERSION), (f) => {
        if (f.kind !== 'deviceInfo') return 'ignore';
        this.set({ deviceInfo: f.info });
        return 'done';
      }).then((err) => this.mustNotBeError(err));
    });
  }

  private mustNotBeError(err: Frame | null): void {
    if (err) throw new BleError('device_error', err.kind === 'error' ? err.name : 'error');
  }

  private async fetchContacts(): Promise<void> {
    const found: Contact[] = [];
    const err = await this.exchange('GET_CONTACTS', encodeGetContacts(), (f) => {
      if (f.kind === 'contactsStart') return 'more';
      if (f.kind === 'contact') {
        // A duplicated notification must not list a contact twice.
        if (!found.some((c) => c.publicKey === f.contact.publicKey)) found.push(f.contact);
        return 'more';
      }
      if (f.kind === 'endOfContacts') return 'done';
      return 'ignore';
    });
    this.mustNotBeError(err);
    this.set({ contacts: found });
  }

  /**
   * Reads the contact list through the same exchange (silence bound, one request at a time). A
   * failure marks the load `failed` and leaves the connection up; it never ends the link.
   */
  async loadContacts(): Promise<void> {
    const epoch = this.linkEpoch;
    this.set({ contactsState: 'loading' });
    try {
      await this.serial(() => this.fetchContacts());
      if (epoch === this.linkEpoch) this.set({ contactsState: 'loaded' });
    } catch (e) {
      if (epoch === this.linkEpoch) this.set({ contactsState: 'failed' });
      throw e;
    }
  }

  async refreshContacts(): Promise<void> {
    await this.loadContacts();
  }

  // -- receive -------------------------------------------------------------
  /** Drains the device's message queue. Read-only on the radio side. Coalesced. */
  async syncMessages(): Promise<void> {
    if (this.syncing || this.snap.bleConnection !== 'connected') return;
    this.syncing = true;
    try {
      await this.serial(async () => {
        for (let i = 0; i < 200; i++) {
          const got: { msg: InboxMessage | null; more: boolean } = { msg: null, more: true };
          const err = await this.exchange('SYNC_NEXT_MESSAGE', encodeSyncNextMessage(), (f) => {
            if (f.kind === 'noMoreMessages') {
              got.more = false;
              return 'done';
            }
            if (f.kind === 'directMessage') got.msg = { kind: 'direct', message: f.message };
            else if (f.kind === 'channelMessage') got.msg = { kind: 'channel', message: f.message };
            else return 'ignore';
            return 'done';
          });
          if (err || !got.more) return;
          if (got.msg) this.addInbox(got.msg);
        }
      });
    } catch {
      /* a failed read leaves the queue on the device; nothing to undo */
    } finally {
      this.syncing = false;
    }
  }

  private addInbox(m: InboxMessage): void {
    const key = (x: InboxMessage) =>
      x.kind === 'direct' ? `d:${x.message.senderKeyPrefix}:${x.message.timestamp}:${x.message.text}` : `c:${x.message.channelIndex}:${x.message.timestamp}:${x.message.text}`;
    const k = key(m);
    if (this.snap.inbox.some((x) => key(x) === k)) return;
    this.set({ inbox: [...this.snap.inbox, m] });
  }

  // -- send ----------------------------------------------------------------
  sendDirect(input: { clientDraftId: string; clientAttemptId: string; contactKey: string; text: string }): Promise<AttemptFacts> {
    // A manual retry of the same draft is a new attempt with the next firmware
    // attempt number, so it is a distinct native packet with its own ACK.
    const firmwareAttempt = Math.min(255, this.snap.attempts.filter((x) => x.clientDraftId === input.clientDraftId).length);
    return this.send('direct', input, input.contactKey.slice(0, KEY_PREFIX_SIZE * 2), () =>
      encodeSendDirect(input.contactKey, input.text, this.nowSec(), firmwareAttempt),
    );
  }

  sendChannel(input: { clientDraftId: string; clientAttemptId: string; channelIndex: number; text: string }): Promise<AttemptFacts> {
    return this.send('channel', input, String(input.channelIndex), () => {
      // The firmware prepends "<own name>: " and cuts the whole at 160 bytes
      // without telling us; without our own name we cannot size the text.
      const name = this.snap.selfInfo?.name;
      if (name === undefined) throw new FrameEncodeError('bad_argument', 'own name unknown: read self info before a channel send');
      return encodeSendChannel(input.channelIndex, input.text, this.nowSec(), name);
    });
  }

  /**
   * Resolves once the attempt has a first outcome (accepted, refused, not sent or
   * unknown). A direct message's ACK arrives later and shows in the snapshot.
   * Throws BleError before anything is recorded for an invalid or reused attempt.
   */
  private async send(
    kind: 'direct' | 'channel',
    ids: { clientDraftId: string; clientAttemptId: string },
    target: string,
    build: () => Uint8Array,
  ): Promise<AttemptFacts> {
    if (!ids.clientDraftId || !ids.clientAttemptId) throw new BleError('bad_argument', 'draft and attempt ids are required');
    if (this.attemptIndex.has(ids.clientAttemptId)) throw new BleError('attempt_reused', 'an attempt id is used once; start a new attempt');
    let frame: Uint8Array;
    try {
      frame = build();
    } catch (e) {
      if (e instanceof FrameEncodeError) throw new BleError(e.reason === 'bad_argument' ? 'bad_argument' : e.reason, e.message);
      throw new BleError('bad_argument');
    }
    const a: AttemptFacts = {
      clientDraftId: ids.clientDraftId,
      clientAttemptId: ids.clientAttemptId,
      path: this.transport.kind,
      kind,
      target,
      writeIssued: false,
      notSent: false,
      deviceAccepted: false,
      rfTransmitted: false,
      dmAck: false,
      ackTimedOut: false,
      unknown: false,
      deviceError: null,
      reason: null,
    };
    this.attemptIndex.set(a.clientAttemptId, a);
    this.set({ attempts: [...this.snap.attempts, { ...a }] });

    await this.serial(() => this.runAttempt(a, frame));
    return { ...a };
  }

  private async runAttempt(a: AttemptFacts, frame: Uint8Array): Promise<void> {
    if (this.snap.bleConnection !== 'connected' || !this.snap.helloComplete) {
      this.touchAttempt(a, { notSent: true, reason: 'not_connected' });
      return;
    }
    if (a.writeIssued) return; // an attempt is written at most once
    a.writeIssued = true;
    this.touchAttempt(a, {});
    try {
      const err = await this.exchange(a.kind === 'direct' ? 'SEND_DIRECT' : 'SEND_CHANNEL', frame, (f) => {
        if (a.kind === 'direct') {
          if (f.kind !== 'sent') return 'ignore';
          this.seenTags.add(f.tag);
          this.tags.set(a.clientAttemptId, f.tag);
          this.touchAttempt(a, { deviceAccepted: true });
          this.armAckTimer(a, f.suggestedTimeoutMs);
          return 'done';
        }
        if (!isChannelSendAccepted(f)) return 'ignore';
        this.touchAttempt(a, { deviceAccepted: true });
        return 'done';
      });
      if (err && err.kind === 'error') this.touchAttempt(a, { deviceError: { code: err.code, name: err.name }, reason: 'device_error' });
    } catch (e) {
      const code = e instanceof BleError ? e.code : 'write_failed';
      // not_connected is raised before any GATT call, so the frame definitely did not go out.
      if (code === 'not_connected') this.touchAttempt(a, { notSent: true, reason: code });
      else await this.settleUnknown(a, code);
    }
  }

  /** The write may have reached the device and we cannot tell. Never retried, never rerouted. */
  private async settleUnknown(a: AttemptFacts, reason: string): Promise<void> {
    this.touchAttempt(a, { unknown: true, reason });
    // The link can no longer be trusted to pair replies with commands (a late reply
    // could be mistaken for the next command's), so the link is reset.
    if (this.snap.bleConnection === 'connected') await this.transport.disconnect();
  }

  private armAckTimer(a: AttemptFacts, suggestedMs: number): void {
    const ms = Math.max(suggestedMs, 1) * 1.5; // device suggests a window; allow some slack
    this.timer(() => {
      if (!a.dmAck) this.touchAttempt(a, { ackTimedOut: true });
    }, ms);
  }

  /**
   * Entry point for future evidence that the radio transmitted. No frame in the
   * current protocol subset calls this; it exists so the fact is only ever set
   * from its own evidence.
   */
  recordRfTransmitEvidence(clientAttemptId: string): void {
    const a = this.attemptIndex.get(clientAttemptId);
    if (a && !a.rfTransmitted) this.touchAttempt(a, { rfTransmitted: true });
  }

  /** Test seam: the Backend path is never used by this adapter. */
  get backendPortForTests(): BackendSendPort | undefined {
    return this.backendPath;
  }
}

/** Transport-neutral names for the BLE-era exports. */
export { BleAdapter as CompanionAdapter };
export type { BleSnapshot as CompanionSnapshot, BleAdapterOptions as CompanionAdapterOptions };

export function newId(prefix: string): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  const rand = c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${rand}`;
}
