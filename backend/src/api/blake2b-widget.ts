import axios from 'axios';
import bitcoinClient from './bitcoin/bitcoin-client';
import logger from '../logger';

/**
 * Datos del cabecero de mempool.kilombino.com ya calculados, para el widget de Android
 * (Kilombino/xbt-widget). Las fórmulas son las de master-page.component.ts; aquí se
 * calculan en el servidor para que la app no las duplique (un 2^34 en una de las dos
 * copias ya nos costó semanas de cifras equivocadas).
 *
 * Todas las fuentes son públicas y sin claves: Neoxa, MiningRigRentals, Kraken y el
 * propio nodo. No hay nada que esconder en el código abierto de la app.
 *
 * PROTECCIONES para que muchas instalaciones no afecten al servidor:
 *  - Caché de 60 s: da igual cuántos móviles pregunten, las APIs externas y el nodo
 *    reciben como mucho una ronda de consultas por minuto.
 *  - Single-flight: si llegan cien peticiones mientras se refresca, esperan todas a la
 *    misma consulta en vez de lanzar cien.
 *  - Datos caducados antes que error: si una fuente externa falla se sirve lo último
 *    bueno (marcado `stale`), hasta 6 h. Así un fallo de Neoxa no hace que todos los
 *    widgets reintenten a la vez.
 *  - `pollMinutes`: el servidor le dice a la app cada cuánto puede volver a preguntar.
 *    Si algún día hay demasiada carga se sube con WIDGET_POLL_MINUTES y todas las apps
 *    lo respetan sin publicar versión nueva.
 *  - El límite por IP (429) va en nginx, delante de esto.
 */

const CACHE_MS = 60_000;
const STALE_MAX_MS = 6 * 3600_000;
const HTTP_TIMEOUT_MS = 8_000;

// Minero de referencia del "1 BTC = kWh": el mismo que el cabecero.
const MINER_NAME = 'Goldshell SC5 Pro II';
const MINER_THS = 14;
const MINER_WATTS = 3300;

interface WidgetData {
  pollMinutes: number;
  updated: number;
  stale: boolean;
  height: number | null;
  thsBtcDay: number | null;
  thsUsdDay: number | null;
  rentPoolsatsPerThDay: number | null;
  rentUsdPerThDay: number | null;
  kwhPerBtc: number | null;
  miner: string;
  yshValue: number | null;
  yshUnit: string | null;
  chainSizeGB: number | null;
  // Precio (añadido para Kilombino wallet: así la app no depende de xbt.live).
  xbtUsd: number | null;
  xbtEur: number | null;
  changePct: number | null;
  high24Usd: number | null;
  low24Usd: number | null;
  xbtPoolsats: number | null;
  poolsatsChangePct: number | null;
  // The spamcoin (SHA-256 chain) in USD, from Kraken.
  spamUsd: number | null;
  // Hashrate total de la red (H/s), media de los últimos 144 bloques (~1 día).
  networkHashps: number | null;
}

class Blake2bWidget {
  private cache: WidgetData | null = null;
  private inflight: Promise<WidgetData> | null = null;

  private pollMinutes(): number {
    const v = parseInt(process.env.WIDGET_POLL_MINUTES || '15', 10);
    return isNaN(v) ? 15 : Math.min(Math.max(v, 15), 24 * 60);
  }

  public async $get(): Promise<WidgetData> {
    const now = Date.now();
    if (this.cache && now - this.cache.updated < CACHE_MS) {
      return { ...this.cache, pollMinutes: this.pollMinutes() };
    }
    if (!this.inflight) {
      this.inflight = this.$refresh().finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  private async $json(url: string): Promise<any> {
    const r = await axios.get(url, {
      timeout: HTTP_TIMEOUT_MS,
      headers: { 'User-Agent': 'mempool.kilombino.com widget' },
    });
    return r.data;
  }

  private supplyAtHeight(height: number): number {
    let supply = 0, subsidy = 50, start = 0;
    while (start <= height && subsidy > 0) {
      supply += Math.min(height - start + 1, 210000) * subsidy;
      subsidy /= 2;
      start += 210000;
    }
    return supply;
  }

  private async $refresh(): Promise<WidgetData> {
    const prev = this.cache;
    const settle = async <T>(p: Promise<T>): Promise<T | null> => {
      try { return await p; } catch (e) { return null; }
    };

    const [bci, hashps, hashps144, usdTicker, mrr, kraken, spamTicker, eurusd] = await Promise.all([
      settle(bitcoinClient.getBlockchainInfo() as Promise<any>),
      settle(bitcoinClient.getNetworkHashPs(1008) as Promise<number>),
      settle(bitcoinClient.getNetworkHashPs(144) as Promise<number>),
      settle(this.$json('https://neoxa.exchange/api/exchange/ticker/BTCB2_USDC')),
      settle(this.$json('https://www.miningrigrentals.com/api/v2/rig?type=blake2b&orderby=price&order=asc&count=1')),
      settle(this.$json('https://api.kraken.com/0/public/Ticker?pair=XBTUSD')),
      settle(this.$json('https://neoxa.exchange/api/exchange/ticker/BTCB2_BTC')),
      settle(this.$json('https://api.kraken.com/0/public/Ticker?pair=EURUSD')),
    ]);

    let stale = false;
    const pick = <T>(fresh: T | null, old: T | null | undefined): T | null => {
      if (fresh !== null && fresh !== undefined) { return fresh; }
      if (old !== null && old !== undefined && prev && Date.now() - prev.updated < STALE_MAX_MS) {
        stale = true;
        return old;
      }
      return null;
    };

    const height: number | null = typeof bci?.blocks === 'number' ? bci.blocks : null;
    // Misma normalización que /mining/hashrate: el 29.4.2+ da `difficulty` null y el valor
    // real va en `difficulty_blake2b`, multiplicado por 2^32 respecto a la escala histórica.
    const difficulty: number | null = bci
      ? (bci.difficulty ?? (bci.difficulty_blake2b != null ? bci.difficulty_blake2b / 4294967296 : null))
      : null;
    const xbtUsd = typeof usdTicker?.ticker?.lastPrice === 'number' ? usdTicker.ticker.lastPrice : null;
    const rec = mrr?.data?.records?.[0];
    const mrrBtc = rec?.price?.BTC?.price ? parseFloat(rec.price.BTC.price) : NaN;
    const kr = kraken?.result ? kraken.result[Object.keys(kraken.result)[0]] : null;
    const spamUsd = kr?.c ? parseFloat(kr.c[0]) : NaN;

    // 1 TH/s rinde: subsidio × 86400 × 1e12 / (dificultad × 2^32). 2^32, NO 2^34.
    let thsBtcDay: number | null = null;
    if (height !== null && difficulty) {
      const subsidy = 50 / Math.pow(2, Math.floor(height / 210000));
      thsBtcDay = subsidy * 86400 * 1e12 / (difficulty * Math.pow(2, 32));
    }
    thsBtcDay = pick(thsBtcDay, prev?.thsBtcDay);
    const thsUsdDay = thsBtcDay !== null && xbtUsd !== null ? thsBtcDay * xbtUsd : pick(null, prev?.thsUsdDay);

    const rentPoolsats = pick(!isNaN(mrrBtc) && mrrBtc > 0 ? mrrBtc * 1e8 : null, prev?.rentPoolsatsPerThDay);
    const rentUsd = pick(!isNaN(mrrBtc) && !isNaN(spamUsd) && mrrBtc > 0 ? mrrBtc * spamUsd : null, prev?.rentUsdPerThDay);

    const kwhPerBtc = thsBtcDay && thsBtcDay > 0 ? ((MINER_WATTS / MINER_THS) * 24 / 1000) / thsBtcDay : null;

    let yshValue: number | null = null, yshUnit: string | null = null;
    if (hashps && height !== null) {
      const perBtc = hashps / this.supplyAtHeight(height);
      const units: [number, string][] = [[1e18, 'EH/s'], [1e15, 'PH/s'], [1e12, 'TH/s'], [1e9, 'GH/s'], [1e6, 'MH/s'], [1e3, 'kH/s']];
      yshValue = perBtc; yshUnit = 'H/s';
      for (const [f, u] of units) {
        if (perBtc >= f) { yshValue = perBtc / f; yshUnit = u; break; }
      }
    } else if (prev) {
      yshValue = pick(null, prev.yshValue); yshUnit = prev.yshUnit;
    }

    // Precio de XBT. El euro sale del dólar con el cambio EUR/USD de Kraken (no hay par
    // XBT/EUR). Las unidades de la Spamchain se dan en Poolsats.
    const t = usdTicker?.ticker;
    const num = (v: any): number | null => (typeof v === 'number' && isFinite(v) ? v : null);
    const usdNow = pick(num(t?.lastPrice), prev?.xbtUsd);
    const eurUsdRate = eurusd?.result ? parseFloat(eurusd.result[Object.keys(eurusd.result)[0]]?.c?.[0]) : NaN;
    const xbtEur = usdNow !== null && !isNaN(eurUsdRate) && eurUsdRate > 0 ? usdNow / eurUsdRate : pick(null, prev?.xbtEur);
    // Poolsats per XBT from the two USD prices (Neoxa XBT/USD over Kraken's spamcoin/USD), as
    // xbt.live does. Neoxa's own BTCB2_BTC pair trades rarely and lags: taking its last price
    // made the spamcoin come out at $85 600 when it was at $83 960.
    const spamPx = num(spamTicker?.ticker?.lastPrice);
    const crossPoolsats = usdNow !== null && !isNaN(spamUsd) && spamUsd > 0 ? Math.round(usdNow / spamUsd * 1e8) : null;
    const xbtPoolsats = pick(crossPoolsats ?? (spamPx !== null ? Math.round(spamPx * 1e8) : null), prev?.xbtPoolsats);
    // Its 24h change, consistent with that: XBT's change against the spamcoin's (Kraken open → last).
    const spamOpen = kr?.o ? parseFloat(kr.o) : NaN;
    const xbtChg = num(t?.changePercent);
    const poolsatsChange = xbtChg !== null && !isNaN(spamOpen) && spamOpen > 0 && !isNaN(spamUsd)
      ? ((1 + xbtChg / 100) / (spamUsd / spamOpen) - 1) * 100 : num(spamTicker?.ticker?.changePercent);

    const chainSizeGB = pick(typeof bci?.size_on_disk === 'number' ? bci.size_on_disk / 1e9 : null, prev?.chainSizeGB);

    const data: WidgetData = {
      pollMinutes: this.pollMinutes(),
      updated: Date.now(),
      stale,
      height: pick(height, prev?.height),
      thsBtcDay,
      thsUsdDay,
      rentPoolsatsPerThDay: rentPoolsats,
      rentUsdPerThDay: rentUsd,
      kwhPerBtc,
      miner: MINER_NAME,
      yshValue,
      yshUnit,
      chainSizeGB,
      xbtUsd: usdNow,
      xbtEur,
      changePct: pick(num(t?.changePercent), prev?.changePct),
      high24Usd: pick(num(t?.high24h), prev?.high24Usd),
      low24Usd: pick(num(t?.low24h), prev?.low24Usd),
      xbtPoolsats,
      poolsatsChangePct: pick(poolsatsChange, prev?.poolsatsChangePct),
      spamUsd: pick(!isNaN(spamUsd) ? spamUsd : null, prev?.spamUsd),
      networkHashps: pick(num(hashps144), prev?.networkHashps),
    };
    if (stale) { logger.debug('blake2b widget: some sources failed, serving last good values'); }
    this.cache = data;
    return data;
  }
}

export default new Blake2bWidget();
