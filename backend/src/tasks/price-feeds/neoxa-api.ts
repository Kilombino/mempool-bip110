import { query } from '../../utils/axios-query';
import priceUpdater, { PriceFeed, PriceHistory } from '../price-updater';

/**
 * Precio de Bitcoin-Blake2b (BTCB2) desde neoxa.exchange, el único exchange donde
 * cotiza. Esta cadena es un fork BLAKE2b: el "precio de bitcoin" de los exchanges
 * normales (Kraken, Coinbase…) es el de la cadena SHA-256 y no aplica aquí, así que
 * este feed sustituye a todos. neoxa cotiza contra USDC, que tratamos como USD.
 */
class NeoxaApi implements PriceFeed {
  public name: string = 'Neoxa';
  public currencies: string[] = ['USD'];

  public url: string = 'https://neoxa.exchange/api/exchange/ticker/BTCB2_USDC';
  public urlHist: string = 'https://neoxa.exchange/api/exchange/candles/BTCB2_USDC';

  constructor() {
  }

  /** @asyncUnsafe */
  public async $fetchPrice(currency): Promise<number> {
    if (currency !== 'USD') {
      return -1;
    }
    const response = await query(this.url);
    const last = response && response['ticker'] ? response['ticker']['lastPrice'] : null;
    return (typeof last === 'number' && last > 0) ? Math.round(last * 100) / 100 : -1;
  }

  /** @asyncUnsafe */
  public async $fetchRecentPrice(currencies: string[], type: 'hour' | 'day'): Promise<PriceHistory> {
    const priceHistory: PriceHistory = {};
    if (currencies.includes('USD') === false) {
      return priceHistory;
    }

    const response = await query(this.urlHist);
    const candles = response && response['candles'] ? response['candles'] : [];
    for (const candle of candles) {
      const t = candle['time'];
      if (t === undefined || candle['close'] === undefined) {
        continue;
      }
      if (priceHistory[t] === undefined) {
        priceHistory[t] = priceUpdater.getEmptyPricesObj();
      }
      priceHistory[t]['USD'] = candle['close'];
    }

    return priceHistory;
  }
}

export default NeoxaApi;
