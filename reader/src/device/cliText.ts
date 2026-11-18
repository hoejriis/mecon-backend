/**
 * The text command line, as the firmware documents it.
 *
 * SOURCES (MIT upstream and the public MECON firmware docs only):
 *  - hoejriis/mecon-firmware @ 5a729ef6127869d404fdffd7e5e08ddbb72a87b5
 *      docs/CLI.md "Classes": `read` is `get ...`, `ver`, `board`, and on a repeater or room
 *        server also `clock`, `neighbors`, `power`, `powersaving`, `region`, `sensor get`, `gps`,
 *        `stats-packets`, `stats-radio`, `stats-core`; every unregistered command is `write`.
 *      docs/CLI_REFERENCE.md "How a command reaches the device": a Repeater, Room server or
 *        Sensor takes a line at the USB serial console. A Companion's serial port speaks binary
 *        frames; its CLI is an app frame on a trusted link, NOT a text line (public firmware
 *        owner, Issue #30, 2026-11-18), so no Companion text-CLI driver exists here.
 *        `ver` answers `v1.18.0-mecon.<tag>... (Build: <date>)`.
 *      This text CLI is a FALLBACK for stock or older firmware that does not answer the
 *      device interface; the interface (meconIface.ts) is the primary path.
 *  - meshcore-dev/MeshCore @ 75b04ef06def54b348400cb1b138afb6749ffd4f
 *      examples/simple_repeater/main.cpp: the console reads characters until CR, echoes each,
 *        prints LF, runs the line, and prints `  -> <reply>` plus newline when there is a reply.
 *      src/helpers/CommonCLI.cpp: `ver` -> `<version> (Build: <date>)`; `board` -> manufacturer
 *        name; `get role` -> `> <role>`; commands are matched by PREFIX (memcmp), which is why the
 *        allowlist below is exact whole-line equality and nothing else.
 *      docs/cli_commands.md: `get role` "View this node's configured role".
 *
 * UNVERIFIED: the role string values (FIRMWARE_ROLE is a build flag); that `get role` exists on
 * every MECON build; the console's echo and `  -> ` reply format on a real MECON board; that a
 * stock consoles answer `get role` the same way.
 */
export const CLI_REPLY_PREFIX = '  -> ';

/**
 * The ONLY command lines the Reader may send as CLI text. Each is documented as
 * read-class and takes no argument. Do not extend without a review: the firmware
 * matches by prefix, so a line that merely starts with one of these must never be built.
 * `get prv.key` and every `set`, `password`, `advert`, `reboot`, `erase` line are absent on purpose.
 */
export const CLI_READ_ONLY_LINES: readonly string[] = Object.freeze(['ver', 'board', 'get role', 'get mecon.version']);

export function isCliReadOnly(line: string): boolean {
  return CLI_READ_ONLY_LINES.includes(line);
}

export function encodeCliLine(line: string): Uint8Array {
  return new TextEncoder().encode(`${line}\r`);
}

/** Splits a byte stream into text lines on CR or LF; empty lines are dropped. Bounded per line. */
export class LineSplitter {
  private buf = '';
  private readonly dec = new TextDecoder('utf-8', { fatal: false });
  constructor(private readonly maxLine = 2048) {}

  feed(chunk: Uint8Array): string[] {
    const out: string[] = [];
    for (const ch of this.dec.decode(chunk, { stream: true })) {
      if (ch === '\r' || ch === '\n') {
        if (this.buf.length) out.push(this.buf);
        this.buf = '';
      } else if (this.buf.length < this.maxLine) this.buf += ch;
    }
    return out;
  }

  reset(): void {
    this.buf = '';
  }
}

/** The text after `  -> ` of a console reply line, or null when the line is not one. */
export function cliReplyText(line: string): string | null {
  return line.startsWith(CLI_REPLY_PREFIX) ? line.slice(CLI_REPLY_PREFIX.length).trim() : null;
}

export type CliRole = 'companion' | 'repeater' | 'room' | 'sensor';

/** Reads a `get role` reply (`> repeater`). Anything unrecognised is null: it is never guessed. */
export function parseRoleReply(reply: string): CliRole | null {
  const t = reply.replace(/^>\s*/, '').trim().toLowerCase();
  if (t === 'repeater') return 'repeater';
  if (t === 'room_server' || t === 'room') return 'room';
  if (t === 'sensor') return 'sensor';
  if (t === 'companion') return 'companion';
  return null;
}

/** MECON identity from `ver`: `v1.18.0-mecon.0.1.3 (Build: ...)`. Null for anything else. */
export function parseMeconVersion(reply: string): string | null {
  const m = /^(v\d+\.\d+\.\d+-mecon\.[0-9A-Za-z.+-]+)/.exec(reply.replace(/^>\s*/, '').trim());
  return m ? m[1]! : null;
}
