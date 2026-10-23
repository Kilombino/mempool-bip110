import axios from 'axios';
import * as crypto from 'crypto';
import * as tls from 'tls';
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
 * For each spent output it also tries to name the Spamchain transaction that spent it
 * (`spenders`). Bitcoin Core can't answer that, so it asks our own Spamchain Electrum
 * server (SPAMCHAIN_ELECTRUM_HOST/PORT, TLS) for the history of the output's script and
 * checks which of those transactions spends it. Outputs it doesn't find there (the server
 * doesn't index every script type) are looked for in the Spamchain mempool and in the
 * SPENDER_SCAN_BLOCKS blocks after the transaction's own. Without the Electrum server,
 * `spenders` is left out.
 *
 * It only asks our own Spamchain servers (SPAMCHAIN_RPC_URL/USER/PASS), never a public
 * explorer, so nobody else learns which transactions people look up here. The node
 * needs txindex=1. SPAMCHAIN_EXPLORER_URL, if set, is passed on as `explorer` so the
 * page can link to the same transaction on a Spamchain explorer.
 *
 * Results are cached for 60 s per txid (at most CACHE_MAX entries), and requests for
 * the same txid while one is in flight share it.
 */

const CACHE_MS = 60_000;
const CACHE_MAX = 5_000;
const HTTP_TIMEOUT_MS = 8_000;
const ELECTRUM_TIMEOUT_MS = 10_000;
const MAX_SPENDER_CANDIDATES = 50; // history entries checked per output, from the oldest that can spend it
const SPENDER_SCAN_BLOCKS = 6; // blocks after the tx's own scanned for spenders the Electrum server can't index (e.g. P2SH)

export interface SpamchainStatus {
  txid: string;
  status: 'confirmed' | 'mempool' | 'absent' | 'unavailable';
  height?: number;
  time?: number;
  outputs?: ('spent' | 'unspent' | 'none')[];
  spenders?: (string | null)[]; // Spamchain txid that spent each output, null if not spent or not found
  explorer?: string;
}

/** One-shot Electrum session: sends the requests in order and returns their results. */
function electrumCall(requests: [string, any[]][]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const results: any[] = [];
    let buf = '';
    const sock = tls.connect({
      host: process.env.SPAMCHAIN_ELECTRUM_HOST,
      port: parseInt(process.env.SPAMCHAIN_ELECTRUM_PORT || '50002', 10),
      rejectUnauthorized: false, // our own server on the LAN, self-signed
    });
    const done = (err?: Error) => {
      clearTimeout(timer);
      sock.destroy();
      err ? reject(err) : resolve(results);
    };
    const timer = setTimeout(() => done(new Error('Electrum timeout')), ELECTRUM_TIMEOUT_MS);
    const all: [string, any[]][] = [['server.version', ['mempool', '1.4']], ...requests];
    sock.on('secureConnect', () => {
      sock.write(all.map(([method, params], id) => JSON.stringify({ jsonrpc: '2.0', id, method, params })).join('\n') + '\n');
    });
    sock.on('data', (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) {
          continue;
        }
        const msg = JSON.parse(line);
        if (typeof msg.id !== 'number') {
          continue;
        }
        if (msg.error) {
          return done(new Error(msg.error.message));
        }
        results[msg.id] = msg.result;
        if (Object.keys(results).length === all.length) {
          results.shift();
          return done();
        }
      }
    });
    sock.on('error', (e) => done(e));
  });
}

class Spamchain {
  private cache = new Map<string, { at: number; data: SpamchainStatus }>();
  private inFlight = new Map<string, Promise<SpamchainStatus>>();

  get enabled(): boolean {
    return !!process.env.SPAMCHAIN_RPC_URL;
  }

  /**
   * Which Spamchain transactions spent these outputs of `txid`. The history of each
   * output's script lists every transaction that paid to or spent from it; the spender
   * is the one, at or after `height` (or in the mempool), with an input on that output.
   */
  private async $spenders(txid: string, height: number | undefined, vouts: any[]): Promise<(string | null)[]> {
    const spenders: (string | null)[] = vouts.map(() => null);
    const wanted = vouts.map((v, n) => v ? n : -1).filter(n => n >= 0);
    if (!wanted.length) {
      return spenders;
    }
    const histories = await electrumCall(wanted.map(n => ['blockchain.scripthash.get_history', [
      crypto.createHash('sha256').update(Buffer.from(vouts[n].scriptPubKey.hex, 'hex')).digest().reverse().toString('hex')
    ]]));
    for (const [k, n] of wanted.entries()) {
      const candidates = (histories[k] || [])
        .filter((h: any) => h.tx_hash !== txid && (h.height <= 0 || height === undefined || h.height >= height))
        .sort((a: any, b: any) => (a.height <= 0 ? Infinity : a.height) - (b.height <= 0 ? Infinity : b.height))
        .slice(0, MAX_SPENDER_CANDIDATES);
      for (const c of candidates) {
        const ctx = await this.rpc('getrawtransaction', [c.tx_hash, true]);
        if (ctx.vin.some((i: any) => i.txid === txid && i.vout === n)) {
          spenders[n] = c.tx_hash;
          break;
        }
      }
    }
    let missing = wanted.filter(n => !spenders[n]);
    if (missing.length) {
      // The node may not allow this call (rpcwhitelist): then only the block scan is left.
      const inMempool = await this.rpc('gettxspendingprevout', [missing.map(n => ({ txid, vout: n }))]).catch(() => []);
      for (const r of inMempool) {
        if (r.spendingtxid) {
          spenders[r.vout] = r.spendingtxid;
        }
      }
      missing = wanted.filter(n => !spenders[n]);
    }
    for (let h = height ?? 0; missing.length && height !== undefined && h <= height + SPENDER_SCAN_BLOCKS; h++) {
      let block: any;
      try {
        block = await this.rpc('getblock', [await this.rpc('getblockhash', [h]), 2]);
      } catch (e) {
        break; // past the tip
      }
      for (const btx of block.tx) {
        for (const i of btx.vin) {
          if (i.txid === txid && missing.includes(i.vout)) {
            spenders[i.vout] = btx.txid;
          }
        }
      }
      missing = wanted.filter(n => !spenders[n]);
    }
    return spenders;
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
        return { txid, status: 'absent', explorer: process.env.SPAMCHAIN_EXPLORER_URL || undefined };
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
      const explorer = process.env.SPAMCHAIN_EXPLORER_URL || undefined;
      const header = tx.blockhash ? await this.rpc('getblockheader', [tx.blockhash, true]) : undefined;
      let spenders: (string | null)[] | undefined;
      if (process.env.SPAMCHAIN_ELECTRUM_HOST && outputs.includes('spent')) {
        try {
          spenders = await this.$spenders(txid, header?.height, tx.vout.map((v: any, n: number) => outputs[n] === 'spent' ? v : null));
        } catch (e: any) {
          logger.warn(`Spamchain spenders of ${txid} failed: ${e.message}`);
        }
      }
      if (!header) {
        return { txid, status: 'mempool', outputs, spenders, explorer };
      }
      return { txid, status: 'confirmed', height: header.height, time: header.time, outputs, spenders, explorer };
    } catch (e: any) {
      logger.warn(`Spamchain lookup of ${txid} failed: ${e.message}`);
      return { txid, status: 'unavailable' };
    }
  }
}

export default new Spamchain();
