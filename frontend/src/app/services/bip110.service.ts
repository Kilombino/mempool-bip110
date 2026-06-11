import { Injectable } from '@angular/core';

/**
 * BIP110 (Reduced Data Temporary Softfork) Service
 *
 * Provides utilities for detecting and displaying BIP110-related information:
 * - Miner signaling detection (deployment 'reduced_data', version bit 4, 55% threshold)
 * - Transaction violation flags for all 7 BIP110 consensus rules
 *
 * See bip-0110.mediawiki for the full specification.
 *
 * NOTE: Uses BigInt for all flag operations because violation flags use bits 45-51,
 * which exceed JavaScript's 32-bit limit for bitwise operators. Bit positions MUST
 * match the backend TransactionFlags (mempool.interfaces.ts) and filters.utils.ts.
 */
@Injectable({
  providedIn: 'root'
})
export class Bip110Service {
  static readonly VERSION_BIT = 4;

  // BIP110 violation flag bit positions (bits 45-51) — MUST match backend TransactionFlags
  static readonly FLAGS = {
    LARGE_SCRIPTPUBKEY:  0x20_00_00_00_00_00n,     // bit 45 - Rule 1: scriptPubKey > 34 bytes (OP_RETURN > 83)
    LARGE_PUSHDATA:      0x40_00_00_00_00_00n,     // bit 46 - Rule 2: script-argument witness/PUSHDATA item > 256 bytes
    UNDEFINED_WITNESS:   0x80_00_00_00_00_00n,     // bit 47 - Rule 3: undefined witness/Tapleaf version
    TAPROOT_ANNEX:       0x01_00_00_00_00_00_00n,  // bit 48 - Rule 4: Taproot annex present
    LARGE_CONTROL_BLOCK: 0x02_00_00_00_00_00_00n,  // bit 49 - Rule 5: control block > 257 bytes
    OP_SUCCESS:          0x04_00_00_00_00_00_00n,  // bit 50 - Rule 6: OP_SUCCESS* in tapscript
    OP_IF_NOTIF:         0x08_00_00_00_00_00_00n,  // bit 51 - Rule 7: OP_IF/OP_NOTIF executing in tapscript
  };

  // Combined mask for any BIP110 violation (BigInt)
  static readonly ANY_VIOLATION_MASK: bigint =
    Bip110Service.FLAGS.LARGE_SCRIPTPUBKEY |
    Bip110Service.FLAGS.LARGE_PUSHDATA |
    Bip110Service.FLAGS.UNDEFINED_WITNESS |
    Bip110Service.FLAGS.TAPROOT_ANNEX |
    Bip110Service.FLAGS.LARGE_CONTROL_BLOCK |
    Bip110Service.FLAGS.OP_SUCCESS |
    Bip110Service.FLAGS.OP_IF_NOTIF;

  private static toBigInt(flags: number | bigint | undefined | null): bigint {
    if (flags === undefined || flags === null) { return 0n; }
    return typeof flags === 'bigint' ? flags : BigInt(flags);
  }

  /**
   * Check if transaction flags indicate any BIP110 violation (static)
   */
  static hasAnyViolation(flags: number | bigint | undefined | null): boolean {
    if (flags === undefined || flags === null) { return false; }
    return (Bip110Service.toBigInt(flags) & Bip110Service.ANY_VIOLATION_MASK) !== 0n;
  }

  /**
   * Get human-readable list of BIP110 violations from flags (static)
   */
  static getViolationLabels(flags: number | bigint | undefined | null): string[] {
    if (flags === undefined || flags === null) { return []; }
    const f = Bip110Service.toBigInt(flags);
    const violations: string[] = [];
    if (f & Bip110Service.FLAGS.LARGE_SCRIPTPUBKEY) { violations.push('⚠️ Rule 1: Large scriptPubKey (>34 bytes)'); }
    if (f & Bip110Service.FLAGS.LARGE_PUSHDATA) { violations.push('⚠️ Rule 2: Large PUSHDATA/witness element (>256 bytes)'); }
    if (f & Bip110Service.FLAGS.UNDEFINED_WITNESS) { violations.push('⚠️ Rule 3: Spending undefined witness version (not v0/v1/P2A)'); }
    if (f & Bip110Service.FLAGS.TAPROOT_ANNEX) { violations.push('⚠️ Rule 4: Taproot annex present'); }
    if (f & Bip110Service.FLAGS.LARGE_CONTROL_BLOCK) { violations.push('⚠️ Rule 5: Large control block (>257 bytes)'); }
    if (f & Bip110Service.FLAGS.OP_SUCCESS) { violations.push('⚠️ Rule 6: OP_SUCCESS* in tapscript'); }
    if (f & Bip110Service.FLAGS.OP_IF_NOTIF) { violations.push('⚠️ Rule 7: OP_IF/OP_NOTIF executing in tapscript'); }
    return violations;
  }

  /**
   * Check if block version signals BIP110 support
   */
  isSignaling(version: number): boolean {
    return (version & (1 << Bip110Service.VERSION_BIT)) !== 0;
  }

  hasAnyViolation(flags: number | bigint | undefined | null): boolean {
    return Bip110Service.hasAnyViolation(flags);
  }

  getViolations(flags: number | bigint | undefined | null): string[] {
    return Bip110Service.getViolationLabels(flags);
  }

  getViolationCount(flags: number | bigint | undefined | null): number {
    return this.getViolations(flags).length;
  }
}
