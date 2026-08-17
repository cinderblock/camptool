/**
 * A minimal USTAR writer — pure, so it can be unit-tested without touching a
 * disk (see plans/complete-backup.md).
 *
 * Why tar and not zip: the backup has to stream. A zip's central directory
 * needs every entry's CRC and compressed size, and its 32-bit fields cap an
 * archive at 4 GB without the ZIP64 machinery. A tar is just
 * `header, data, header, data, …` with a fixed 512-byte block, so it can be
 * produced one file at a time with bounded memory and no total-size limit —
 * and `tar -xzf backup.tar.gz -C /srv/camptool/data` puts everything back
 * exactly where it came from.
 */

export const BLOCK_SIZE = 512;

/** Left-padded octal, NUL-terminated — how USTAR writes every number. */
function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function writeAscii(block: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    block[offset + i] = text.charCodeAt(i) & 0xff;
  }
}

/**
 * One 512-byte USTAR header.
 *
 * `name` must be at most 100 bytes. Every path this app writes is well under
 * that (`uploads/<uuid>/<uuid>.display` is 90), and the alternative — GNU long
 * names or the `prefix` field — is complexity with no caller. Throwing is
 * therefore the honest response: a silently truncated path in a BACKUP is the
 * kind of bug you discover only when you need it to work.
 */
export function tarHeader(
  name: string,
  size: number,
  mtimeSeconds: number,
): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  if (nameBytes.length > 100) {
    throw new Error(
      `tar entry name too long (${nameBytes.length} > 100): ${name}`,
    );
  }
  // 11 octal digits — the USTAR ceiling for a single member.
  if (size > 0o77777777777) {
    throw new Error(`tar entry too large for USTAR: ${name} (${size} bytes)`);
  }

  const block = new Uint8Array(BLOCK_SIZE);
  block.set(nameBytes, 0);
  writeAscii(block, 100, octal(0o644, 8)); // mode
  writeAscii(block, 108, octal(0, 8)); // uid
  writeAscii(block, 116, octal(0, 8)); // gid
  writeAscii(block, 124, octal(size, 12));
  writeAscii(block, 136, octal(Math.floor(mtimeSeconds), 12));
  // Checksum is computed with this field read as eight spaces, then written
  // back over it — the one genuinely odd corner of the format.
  writeAscii(block, 148, "        ");
  block[156] = 0x30; // typeflag '0' = regular file
  writeAscii(block, 257, "ustar\0");
  writeAscii(block, 263, "00");

  let sum = 0;
  for (const byte of block) sum += byte;
  // Six octal digits, then NUL, then a space. Not a typo — that is the spec.
  writeAscii(block, 148, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

/** Zero bytes to round `size` up to the next 512-byte block, if any. */
export function tarPadding(size: number): Uint8Array | null {
  const remainder = size % BLOCK_SIZE;
  return remainder === 0 ? null : new Uint8Array(BLOCK_SIZE - remainder);
}

/** Two zero blocks mark the end of a tar archive. */
export function tarTrailer(): Uint8Array {
  return new Uint8Array(BLOCK_SIZE * 2);
}
