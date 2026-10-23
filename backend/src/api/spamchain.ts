import axios from 'axios';
import logger from '../logger';

/**
 * Does a BLAKE2b (XBT) transaction also exist on the Spamchain (the SHA-256 chain)?
 *
 * Both chains share their history up to the fork, so a transaction that only spends
 * pre-fork coins, and has no BLAKE2b-only signature (unified sighash), is valid on both:
 * whoever broadcasts it to one can copy it to the other. This answers, for one txid:
 *  - `confirmed` on the Spamchain (with its height and time), `mempool`, or `absent`;
 *  - for each output, whether the Spamchain has already spent it (`spent`), still has it
 *    (`unspent`), or it can't be spent at all (`none`, OP_RETURN). An output spent on the
 *    Spamchain but not here is where the coins split.
 *
 * It only asks our own Spamchain node (SPAMCHAIN_RPC_URL/USER/PASS), never a public
 * explorer, so nobody else learns which transactions people look up here. The node
 * needs txindex=1.
 *
 * Results are cached for 60 s per txid (at most CACHE_MAX entries), and requests for
 * the same txid while one is in flight share it.
 */

const CACHE_MS = 60_000;
const CACHE_MAX = 5_000;
const HTTP_TIMEOUT_MS = 8_000;

export interface SpamchainStatus {
  txid: string;
  status: 'confirmed' | 'mempool' | 'absent' | 'unavailable';
  height?: number;
  time?: number;
  outputs?: ('spent' | 'unspent' | 'none')[];
}

class Spamchain {
  private cache = new Map<string, { at: number; data: SpamchainStatus }>();
  private inFlight = new Map<string, Promise<SpamchainStatus>>();

  get enabled(): boolean {
    return !!process.env.SPAMCHAIN_RPC_URL;
  }

  private async rpc(method: string, params: any[]): Promise<any> {
    const res = await axios.post(process.env.SPAMCHAIN_RPC_URL as string,
      { jsonrpc: '1.0', id: 'mempool', method, params },
      {
        auth: { username: process.env.SPAMCHAIN_RPC_USER || '', password: process.env.SPAMCHAIN_RPC_PASS || '' },
        timeout: HTTP_TIMEOUT_MS,
        validateStatus: () => true, // bitcoind answers RPC errors with HTTP 500 and a JSON body
      });
    if (res.data?.error) {
      const e: any = new Error(res.data.error.message);
      e.code = res.data.error.code;
      throw e;
    }
    if (res.status !== 200) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.data.result;
  }

  public async $get(txid: string): Promise<SpamchainStatus> {
    const hit = this.cache.get(txid);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      return hit.data;
    }
    const pending = this.inFlight.get(txid);
    if (pending) {
      return pending;
    }
    const p = this.$lookup(txid).finally(() => this.inFlight.delete(txid));
    this.inFlight.set(txid, p);
    const data = await p;
    if (data.status !== 'unavailable') {
      if (this.cache.size >= CACHE_MAX) {
        this.cache.delete(this.cache.keys().next().value as string);
      }
      this.cache.set(txid, { at: Date.now(), data });
    }
    return data;
  }

  private async $lookup(txid: string): Promise<SpamchainStatus> {
    let tx: any;
    try {
      tx = await this.rpc('getrawtransaction', [txid, true]);
    } catch (e: any) {
      if (e.code === -5) {
        return { txid, status: 'absent' };
      }
      logger.warn(`Spamchain lookup of ${txid} failed: ${e.message}`);
      return { txid, status: 'unavailable' };
    }
    try {
      const outputs: SpamchainStatus['outputs'] = [];
      for (const vout of tx.vout) {
        if (vout.scriptPubKey?.type === 'nulldata') {
          outputs.push('none');
          continue;
        }
        const utxo = await this.rpc('gettxout', [txid, vout.n, true]);
        outputs.push(utxo ? 'unspent' : 'spent');
      }
      if (!tx.blockhash) {
        return { txid, status: 'mempool', outputs };
      }
      const header = await this.rpc('getblockheader', [tx.blockhash, true]);
      return { txid, status: 'confirmed', height: header.height, time: header.time, outputs };
    } catch (e: any) {
      logger.warn(`Spamchain lookup of ${txid} failed: ${e.message}`);
      return { txid, status: 'unavailable' };
    }
  }
}

export default new Spamchain();
