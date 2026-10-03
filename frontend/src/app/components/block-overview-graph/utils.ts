import { feeLevels, defaultMempoolFeeColors, contrastMempoolFeeColors } from '@app/app.constants';
import { Color } from '@components/block-overview-graph/sprite-types';
import TxView from '@components/block-overview-graph/tx-view';
import { TransactionFlags } from '@app/shared/filters.utils';

// Combined bitmask for all 7 BIP110 violation flags (per bip-0110.mediawiki Specification)
const BIP110_VIOLATION_MASK = 
  TransactionFlags.bip110_large_scriptpubkey |
  TransactionFlags.bip110_large_pushdata |
  TransactionFlags.bip110_undefined_witness |
  TransactionFlags.bip110_taproot_annex |
  TransactionFlags.bip110_large_control_block |
  TransactionFlags.bip110_op_success |
  TransactionFlags.bip110_op_if_notif;

// Check if transaction has any BIP110 violation
export function hasBIP110Violation(tx: TxView): boolean {
  return tx.bigintFlags ? (tx.bigintFlags & BIP110_VIOLATION_MASK) !== 0n : false;
}

// BIP110 pulse state - oscillates between bright and dim orange
let bip110PulsePhase = 0;
export function getBIP110PulsePhase(): number {
  return bip110PulsePhase;
}
export function setBIP110PulsePhase(phase: number): void {
  bip110PulsePhase = phase;
}

// Get pulsing BIP110 color based on current phase
export function getPulsingBIP110Color(): Color {
  // Pulse between vivid red and bright orange (never green, so it pops against the
  // green/blue transaction sea). High-contrast, attention-grabbing.
  const pulse = 0.5 + 0.5 * Math.sin(bip110PulsePhase);
  // Deep red (ff1500) at pulse=0 -> bright orange (ff8a00) at pulse=1
  return {
    r: 1.0,                   // full red channel always
    g: 0.08 + 0.46 * pulse,   // 0.08 (deep red) to 0.54 (bright orange)
    b: 0.0,
    a: 1
  };
}

export function hexToColor(hex: string): Color {
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
    a: hex.length > 6 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
  };
}

export function colorToHex(color: Color): string {
  return [color.r, color.g, color.b].map(c => Math.max(0, Math.min(Math.round(c * 255), 255)).toString(16)).join('');
}

export function desaturate(color: Color, amount: number): Color {
  const gray = (color.r + color.g + color.b) / 6;
  return {
    r: color.r + ((gray - color.r) * amount),
    g: color.g + ((gray - color.g) * amount),
    b: color.b + ((gray - color.b) * amount),
    a: color.a,
  };
}

export function darken(color: Color, amount: number): Color {
  return {
    r: color.r * amount,
    g: color.g * amount,
    b: color.b * amount,
    a: color.a,
  };
}

export function mix(color1: Color, color2: Color, amount: number): Color {
  // clamp to 0-1
  amount = Math.max(0, Math.min(amount, 1));
  return {
    r: color1.r * (1 - amount) + color2.r * amount,
    g: color1.g * (1 - amount) + color2.g * amount,
    b: color1.b * (1 - amount) + color2.b * amount,
    a: color1.a * (1 - amount) + color2.a * amount,
  };
}

export function setOpacity(color: Color, opacity: number): Color {
  return {
    ...color,
    a: opacity
  };
}

interface ColorPalette {
  base: Color[],
  audit: Color[],
  marginal: Color[],
  baseLevel: (tx: TxView, rate: number, time: number) => number,
}

// precomputed colors
const defaultColors: { [key: string]: ColorPalette } = {
  fee: {
    base: defaultMempoolFeeColors.map(hexToColor),
    audit: [],
    marginal: [],
    baseLevel: (tx: TxView, rate: number) => feeLevels.findIndex((feeLvl) => Math.max(0, rate) < feeLvl) - 1
  },
};
for (const key in defaultColors) {
  const base = defaultColors[key].base;
  defaultColors[key].audit = base.map((color) => darken(desaturate(color, 0.3), 0.9));
  defaultColors[key].marginal = base.map((color) => darken(desaturate(color, 0.8), 1.1));
  defaultColors['unmatched' + key] = {
    base: defaultColors[key].base.map(c => setOpacity(c, 0.2)),
    audit: defaultColors[key].audit.map(c => setOpacity(c, 0.2)),
    marginal: defaultColors[key].marginal.map(c => setOpacity(c, 0.2)),
    baseLevel: defaultColors[key].baseLevel,
  };
}


/**
 * XBT tint ("Rate"): a vivid scale tuned to XBT fees, which mostly sit between 0.1 and 10 sat/vB,
 * where the classic palette shows almost the same olive for everything. Colours by EFFECTIVE
 * fee rate (CPFP packages included), from blue (cheapest) through green, yellow and red to
 * magenta (highest).
 */
export const rateLevels = [0, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 7, 10, 15, 20, 30, 50, 75, 100, 150, 250, 500, 1000];
export const rateHex = ['1d3fed', '1d6bed', '1d97ed', '1dc2ed', '1dedeb', '1dedbf', '1ded94', '1ded68', '1ded3c', '29ed1d', '54ed1d', '80ed1d', 'aced1d', 'd8ed1d', 'edd61d', 'edaa1d', 'ed7f1d', 'ed531d', 'ed271d', 'ed1d3e', 'ed1d69', 'ed1d95', 'ed1dc1', 'ed1ded'];
export const rateColors = rateHex.map(hexToColor);

export function rateLevelIndex(rate: number): number {
  const i = rateLevels.findIndex((lvl) => Math.max(0, rate) < lvl) - 1;
  return i < 0 ? rateLevels.length - 1 : i;
}

export function rateColorFunction(tx: TxView): Color {
  if (hasBIP110Violation(tx)) {
    return getPulsingBIP110Color();
  }
  const rate = tx.feerate || (tx.fee / tx.vsize);
  return rateColors[rateLevelIndex(rate)];
}

export { defaultColors as defaultColors };

export const defaultAuditColors = {
  censored: hexToColor('f344df'),
  missing: darken(desaturate(hexToColor('f344df'), 0.3), 0.7),
  added: hexToColor('0099ff'),
  added_prioritized: darken(desaturate(hexToColor('0099ff'), 0.15), 0.85),
  prioritized: darken(desaturate(hexToColor('0099ff'), 0.3), 0.7),
  accelerated: hexToColor('8f5ff6'),
  // BIP110 violation - neon orange warning
  bip110_violation: hexToColor('ff1500'),
};

const contrastColors: { [key: string]: ColorPalette } = {
  fee: {
    base: contrastMempoolFeeColors.map(hexToColor),
    audit: [],
    marginal: [],
    baseLevel: (tx: TxView, rate: number) => feeLevels.findIndex((feeLvl) => Math.max(0, rate) < feeLvl) - 1
  },
};
for (const key in contrastColors) {
  const base = contrastColors[key].base;
  contrastColors[key].audit = base.map((color) => darken(desaturate(color, 0.3), 0.9));
  contrastColors[key].marginal = base.map((color) => darken(desaturate(color, 0.8), 1.1));
  contrastColors['unmatched' + key] = {
    base: contrastColors[key].base.map(c => setOpacity(c, 0.2)),
    audit: contrastColors[key].audit.map(c => setOpacity(c, 0.2)),
    marginal: contrastColors[key].marginal.map(c => setOpacity(c, 0.2)),
    baseLevel: contrastColors[key].baseLevel,
  };
}

export { contrastColors as contrastColors };

export const contrastAuditColors = {
  censored: hexToColor('ffa8ff'),
  missing: darken(desaturate(hexToColor('ffa8ff'), 0.3), 0.7),
  added: hexToColor('00bb98'),
  added_prioritized: darken(desaturate(hexToColor('00bb98'), 0.15), 0.85),
  prioritized: darken(desaturate(hexToColor('00bb98'), 0.3), 0.7),
  accelerated: hexToColor('8f5ff6'),
  // BIP110 violation - neon orange warning (brighter for contrast mode)
  bip110_violation: hexToColor('ff3000'),
};

export function defaultColorFunction(
  tx: TxView,
  colors: { base: Color[], audit: Color[], marginal: Color[], baseLevel: (tx: TxView, rate: number, time: number) => number } = defaultColors.fee,
  auditColors: { [status: string]: Color } = defaultAuditColors,
  relativeTime?: number,
): Color {
  // BIP110 violation takes highest priority - use pulsing orange
  if (hasBIP110Violation(tx)) {
    return getPulsingBIP110Color();
  }
  
  const rate = tx.fee / tx.vsize; // color by simple single-tx fee rate
  const levelIndex = colors.baseLevel(tx, rate, relativeTime || (Date.now() / 1000));
  const levelColor = colors.base[levelIndex] || colors.base[defaultMempoolFeeColors.length - 1];
  // Normal mode
  if (!tx.scene?.highlightingEnabled) {
    if (tx.acc) {
      return auditColors.accelerated;
    } else {
      return levelColor;
    }
    return levelColor;
  }
  // Block audit
  switch(tx.status) {
    case 'censored':
      return auditColors.censored;
    case 'missing':
    case 'sigop':
    case 'rbf':
      return colors.marginal[levelIndex] || colors.marginal[defaultMempoolFeeColors.length - 1];
    case 'fresh':
    case 'freshcpfp':
      return auditColors.missing;
    case 'added':
      return auditColors.added;
    case 'added_prioritized':
      return auditColors.added_prioritized;
    case 'prioritized':
      return auditColors.prioritized;
    case 'added_deprioritized':
      return auditColors.added_prioritized;
    case 'deprioritized':
      return auditColors.prioritized;
    case 'selected':
      return colors.marginal[levelIndex] || colors.marginal[defaultMempoolFeeColors.length - 1];
    case 'accelerated':
      return auditColors.accelerated;
    case 'found':
      if (tx.context === 'projected') {
        return colors.audit[levelIndex] || colors.audit[defaultMempoolFeeColors.length - 1];
      } else {
        return levelColor;
      }
    case 'unmatched':
      if (tx.context === 'stale') {
        return auditColors.censored;
      } else {
        return auditColors.added;
      }
    default:
      if (tx.acc) {
        return auditColors.accelerated;
      } else {
        return levelColor;
      }
  }
}

export function contrastColorFunction(
  tx: TxView,
  colors: { base: Color[], audit: Color[], marginal: Color[], baseLevel: (tx: TxView, rate: number, time: number) => number } = contrastColors.fee,
  auditColors: { [status: string]: Color } = contrastAuditColors,
  relativeTime?: number,
): Color {
  return defaultColorFunction(tx, colors, auditColors, relativeTime);
}

export function ageColorFunction(
  tx: TxView,
  colors: { base: Color[], audit: Color[], marginal: Color[], baseLevel: (tx: TxView, rate: number, time: number) => number } = defaultColors.fee,
  auditColors: { [status: string]: Color } = defaultAuditColors,
  relativeTime?: number,
  theme?: string,
): Color {
  // BIP110 violation takes highest priority - use pulsing color, don't fade with age
  if (hasBIP110Violation(tx)) {
    return getPulsingBIP110Color();
  }
  
  if (tx.acc || tx.status === 'accelerated') {
    return auditColors.accelerated;
  }

  const color = theme !== 'contrast' && theme !== 'bukele' ? defaultColorFunction(tx, colors, auditColors, relativeTime) : contrastColorFunction(tx, colors, auditColors, relativeTime);

  const ageLevel = (!tx.time ? 0 : (0.8 * Math.tanh((1 / 15) * Math.log2((Math.max(1, 0.6 * ((relativeTime - tx.time) - 60)))))));
  return {
    r: color.r,
    g: color.g,
    b: color.b,
    a: color.a * (1 - ageLevel)
  };
}
