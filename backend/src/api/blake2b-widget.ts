import axios from 'axios';
import bitcoinClient from './bitcoin/bitcoin-client';
import logger from '../logger';
import difficultyAdjustment from './difficulty-adjustment';

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
// Tipos de cambio: cambian una vez al día (BCE ~16:00 CET), se piden cada 6 h.
const FIAT_CACHE_MS = 6 * 3600_000;
// Monedas que la app sabe mostrar. Las del BCE salen de su referencia diaria; el resto
// (pesos latinoamericanos, bolívar…) de open.er-api.com, que también es diaria.
const FIATS = ['EUR', 'GBP', 'JPY', 'CHF', 'CNY', 'RON', 'PLN', 'CZK', 'HUF', 'SEK', 'NOK', 'DKK', 'ISK',
  'TRY', 'CAD', 'AUD', 'NZD', 'BRL', 'MXN', 'ARS', 'CLP', 'COP', 'PEN', 'UYU', 'VES', 'INR', 'KRW',
  'HKD', 'SGD', 'ZAR', 'ILS', 'THB', 'IDR', 'PHP', 'MYR'];
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
  // Unidades de cada moneda por 1 USD (precio de XBT en X = xbtUsd × fiatPerUsd[X]); fiatDate = día del tipo.
  fiatPerUsd: { [code: string]: number } | null;
  fiatDate: string | null;
  // Dificultad (escala histórica, la misma que /mining/hashrate: difficulty_blake2b / 2^32).
  // difficultyPrev = la del periodo anterior (bloque justo antes del último reajuste);
  // difficultyNext = estimación del siguiente reajuste = actual × (1 + difficultyChangePct/100).
  difficulty: number | null;
  difficultyPrev: number | null;
  difficultyPrevChangePct: number | null;
  difficultyNext: number | null;
  difficultyChangePct: number | null;
  difficultyRemainingBlocks: number | null;
  difficultyRetargetDate: number | null;
  difficultyRetargetHeight: number | null;
}

const EPOCH = 2016;
const normDifficulty = (h: any): number | null => {
  if (!h) { return null; }
  const d = h.difficulty ?? (h.difficulty_blake2b != null ? h.difficulty_blake2b / 4294967296 : null);
  return typeof d === 'number' && isFinite(d) && d > 0 ? d : null;
};

class Blake2bWidget {
  private cache: WidgetData | null = null;
  private inflight: Promise<WidgetData> | null = null;
  // Dificultad del periodo anterior: solo cambia una vez por periodo, se guarda por altura.
  private prevDiff: { epochStart: number, difficulty: number } | null = null;
  private fiat: { rates: { [code: string]: number }, date: string | null, at: number } | null = null;

  /** Tipos por USD: BCE primero (oficial), open.er-api.com para lo que el BCE no publica. */
  private async $fiatRates(): Promise<{ rates: { [code: string]: number }, date: string | null } | null> {
    if (this.fiat && Date.now() - this.fiat.at < FIAT_CACHE_MS) { return this.fiat; }
    const settle = async <T>(p: Promise<T>): Promise<T | null> => { try { return await p; } catch (e) { return null; } };
    const [ecbXml, er] = await Promise.all([
      settle(this.$json('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml')),
      settle(this.$json('https://open.er-api.com/v6/latest/USD')),
    ]);
    const rates: { [code: string]: number } = {};
    let date: string | null = null;
    if (typeof ecbXml === 'string') {
      const perEur: { [code: string]: number } = {};
      const re = /currency='([A-Z]{3})' rate='([0-9.]+)'/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(ecbXml)) !== null) { perEur[m[1]] = parseFloat(m[2]); }
      const usd = perEur['USD'];
      if (usd > 0) {
        perEur['EUR'] = 1;
        for (const c of FIATS) { if (perEur[c] > 0) { rates[c] = perEur[c] / usd; } }
        date = ecbXml.match(/time='(\d{4}-\d{2}-\d{2})'/)?.[1] ?? null;
      }
    }
    if (er?.result === 'success' && er.rates) {
      for (const c of FIATS) {
        const v = er.rates[c];
        if (rates[c] === undefined && typeof v === 'number' && isFinite(v) && v > 0) { rates[c] = v; }
      }
      if (!date && typeof er.time_last_update_unix === 'number') { date = new Date(er.time_last_update_unix * 1000).toISOString().slice(0, 10); }
    }
    if (Object.keys(rates).length === 0) { return this.fiat; }
    this.fiat = { rates, date, at: Date.now() };
    return this.fiat;
  }

  private async $previousEpochDifficulty(height: number): Promise<number | null> {
    const epochStart = height - (height % EPOCH);
    if (epochStart < 1) { return null; }
    if (this.prevDiff?.epochStart === epochStart) { return this.prevDiff.difficulty; }
    const hash = await bitcoinClient.getBlockHash(epochStart - 1);
    const d = normDifficulty(await bitcoinClient.getBlockHeader(hash, true));
    if (d !== null) { this.prevDiff = { epochStart, difficulty: d }; }
    return d;
  }

  private pollMinutes(): number {
    const v = parseInt(process.env.WIDGET_POLL_MINUTES || '5', 10);
    return isNaN(v) ? 5 : Math.min(Math.max(v, 5), 24 * 60);
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
    const fiat = await settle(this.$fiatRates());
    const diffPrev = height !== null ? await settle(this.$previousEpochDifficulty(height)) : null;
    let da: any = null;
    try { da = difficultyAdjustment.getDifficultyAdjustment(); } catch (e) { da = null; }
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
      fiatPerUsd: fiat?.rates ?? prev?.fiatPerUsd ?? null,
      fiatDate: fiat?.date ?? prev?.fiatDate ?? null,
      ...this.difficultyFields(difficulty, diffPrev, da, height, prev),
    };
    if (stale) { logger.debug('blake2b widget: some sources failed, serving last good values'); }
    this.cache = data;
    return data;
  }

  private difficultyFields(cur: number | null, prevD: number | null, da: any, height: number | null,
    prev: WidgetData | null): Pick<WidgetData, 'difficulty' | 'difficultyPrev' | 'difficultyPrevChangePct' |
    'difficultyNext' | 'difficultyChangePct' | 'difficultyRemainingBlocks' | 'difficultyRetargetDate' |
    'difficultyRetargetHeight'> {
    const num = (v: any): number | null => (typeof v === 'number' && isFinite(v) ? v : null);
    // Si el nodo no responde, se repite lo último bueno tal cual (los datos de reajuste
    // van juntos: mezclar uno nuevo con otro viejo daría cifras incoherentes).
    if (cur === null) {
      const fresh = prev && Date.now() - prev.updated < STALE_MAX_MS;
      return {
        difficulty: fresh ? prev.difficulty ?? null : null,
        difficultyPrev: fresh ? prev.difficultyPrev ?? null : null,
        difficultyPrevChangePct: fresh ? prev.difficultyPrevChangePct ?? null : null,
        difficultyNext: fresh ? prev.difficultyNext ?? null : null,
        difficultyChangePct: fresh ? prev.difficultyChangePct ?? null : null,
        difficultyRemainingBlocks: fresh ? prev.difficultyRemainingBlocks ?? null : null,
        difficultyRetargetDate: fresh ? prev.difficultyRetargetDate ?? null : null,
        difficultyRetargetHeight: fresh ? prev.difficultyRetargetHeight ?? null : null,
      };
    }
    // La variación anterior sale de las dos dificultades del nodo (no de los `bits` que
    // guarda mempool), así es coherente con difficultyPrev pase lo que pase en la cadena.
    const prevPct = prevD ? (cur / prevD - 1) * 100 : null;
    let changePct = num(da?.difficultyChange);
    let remaining = num(da?.remainingBlocks);
    let retargetHeight = num(da?.nextRetargetHeight);
    // El reajuste de mempool va por su propio índice de bloques: si va por detrás o por
    // delante del nodo (otro periodo), no vale para esta dificultad.
    if (height !== null && retargetHeight !== null && retargetHeight !== height - (height % EPOCH) + EPOCH) {
      changePct = null;
    }
    if (height !== null) {
      retargetHeight = height - (height % EPOCH) + EPOCH;
      remaining = retargetHeight - height;
    }
    const next = changePct !== null ? cur * (1 + changePct / 100) : null;
    return {
      difficulty: cur,
      difficultyPrev: prevD,
      difficultyPrevChangePct: prevPct,
      difficultyNext: next,
      difficultyChangePct: changePct,
      difficultyRemainingBlocks: remaining,
      difficultyRetargetDate: changePct !== null ? num(da?.estimatedRetargetDate) : null,
      difficultyRetargetHeight: retargetHeight,
    };
  }
}

export default new Blake2bWidget();
