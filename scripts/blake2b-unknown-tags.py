#!/usr/bin/env python3
"""Report BLAKE2b-chain miners that pools-v2.json does not name.

Walks every block from the fork height to the tip, applies mempool's matching
rules (per pool in list order: payout addresses, then case-insensitive regex
tags) and prints two things:

  1. coinbases that match no entry at all;
  2. entries matched by address whose coinbase carries a primary tag that is
     not part of the entry name (placeholder names such as "Solo bc1q...").

Blocks are cached, so a cron run only fetches what is new; the last six
cached heights are re-checked so a short reorg does not leave stale rows.
Any block-fetch failure leaves the cache untouched and exits 1.

    blake2b-unknown-tags.py [--api URL] [--pools FILE|URL] [--cache FILE]
                            [--fork HEIGHT] [--ignore TAG ...] [--quiet]

Defaults: --api https://mempool.guide/api  (a local backend is usually
http://127.0.0.1:8999/api/v1), --pools the list on Kilombino/mempool-bip110
main, --cache ~/.cache/blake2b-unknown-tags.json, --fork 961640.
Needs only the Python standard library."""
import argparse, collections, json, os, re, sys, time, urllib.request

DEFAULTS = {
    'api': 'https://mempool.guide/api',
    'pools': 'https://raw.githubusercontent.com/Kilombino/mempool-bip110/main/pools-v2.json',
    'cache': os.path.expanduser('~/.cache/blake2b-unknown-tags.json'),
    'fork': 961640,
}
RECHECK = 6  # cached heights re-fetched each run to catch a reorg
HEADLINE = '8-30 NYPost Deride And Conquer'  # required in every fork-block coinbase; never a miner name


def fetch(url, tries=3):
    for i in range(tries):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'blake2b-unknown-tags'}), timeout=30).read()
        except Exception as e:  # noqa: BLE001
            err = e
            time.sleep(2 * (i + 1))
    raise SystemExit(f'# fetch failed: {url}: {err}')


def load_pools(src):
    if re.match(r'https?://', src):
        return json.loads(fetch(src))
    with open(src) as f:
        return json.load(f)


def primary_tag(scriptsig):
    """The miner's readable tag: DATUM writes <primary> 0x0F <secondary> 0x00 <extranonce>
    in the first push after the height push, so take the first 0x0F-separated field
    that has text (a miner with an empty primary tag still gets named)."""
    sig = bytes.fromhex(scriptsig)
    i = 1 + sig[0] if sig else 0
    while i < len(sig):
        op = sig[i]
        i += 1
        if op == 0x4c:
            if i >= len(sig):
                break
            ln = sig[i]
            i += 1
        elif op == 0x4d:
            if i + 1 >= len(sig):
                break
            ln = sig[i] | sig[i + 1] << 8
            i += 2
        elif 1 <= op <= 0x4b:
            ln = op
        else:
            continue  # OP_0, OP_1..OP_16 and other opcodes push no bytes
        for field in sig[i:i + ln].split(b'\x0f'):
            text = field.split(b'\x00')[0].decode('latin1').strip()
            if sum(32 <= ord(ch) < 127 for ch in text) >= 3 and text.lower() != HEADLINE.lower():
                return text
        i += ln
    return ''


def match(pools, scriptsig, addrs):
    """Same order as mempool's matchBlockMiner: per pool, addresses then tags."""
    ascii_sig = bytes.fromhex(scriptsig).decode('latin1')
    for p in pools:
        for a in p.get('addresses') or []:
            if a in addrs:
                return p, 'address'
        for t in p.get('tags') or []:
            try:
                if re.search(t, ascii_sig, re.I):
                    return p, 'tag'
            except re.error:
                pass
    return None, None


def coinbase(api, height):
    h = fetch(f'{api}/block-height/{height}').decode()
    txids = json.loads(fetch(f'{api}/block/{h}/txids'))
    tx = json.loads(fetch(f'{api}/tx/{txids[0]}'))
    return {'hash': h,
            'scriptsig': tx['vin'][0]['scriptsig'],
            'addrs': [o['scriptpubkey_address'] for o in tx['vout'] if o.get('scriptpubkey_address')]}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--api', default=DEFAULTS['api'])
    ap.add_argument('--pools', default=DEFAULTS['pools'], help='pools-v2.json path or URL')
    ap.add_argument('--cache', default=DEFAULTS['cache'])
    ap.add_argument('--fork', type=int, default=DEFAULTS['fork'])
    ap.add_argument('--ignore', nargs='*', default=[], metavar='TAG', help='primary tags not worth reporting')
    ap.add_argument('--quiet', action='store_true', help='print nothing when there is nothing to report')
    a = ap.parse_args()

    pools = load_pools(a.pools)
    try:
        with open(a.cache) as f:
            blocks = {int(k): v for k, v in json.load(f).items()}
    except (OSError, ValueError):
        blocks = {}

    tip = int(fetch(f'{a.api}/blocks/tip/height'))
    start = a.fork if not blocks else max(a.fork, max(blocks) - RECHECK + 1)
    fetched = 0
    for h in range(start, tip + 1):
        cb = coinbase(a.api, h)
        if blocks.get(h, {}).get('hash') != cb['hash']:
            if h in blocks:  # reorg: everything above this height is stale too
                for k in [k for k in blocks if k >= h]:
                    del blocks[k]
            blocks[h] = cb
            fetched += 1
    for k in [k for k in blocks if k > tip]:
        del blocks[k]
    os.makedirs(os.path.dirname(a.cache) or '.', exist_ok=True)
    tmp = a.cache + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(blocks, f)
    os.replace(tmp, a.cache)

    ignore = {t.lower() for t in a.ignore}
    unmatched = collections.OrderedDict()
    placeholder = collections.OrderedDict()
    for h in sorted(blocks):
        b = blocks[h]
        tag = primary_tag(b['scriptsig'])
        pool, how = match(pools, b['scriptsig'], b['addrs'])
        if pool is None:
            key = tag or (b['addrs'][0] if b['addrs'] else b['hash'])
            e = unmatched.setdefault(key, {'count': 0, 'first': h, 'addrs': set()})
        elif how == 'address' and tag and tag.lower() not in ignore \
                and tag.lower() not in pool['name'].lower() and pool['name'].lower() not in tag.lower():
            e = placeholder.setdefault((pool['id'], pool['name'], tag), {'count': 0, 'first': h, 'addrs': set()})
        else:
            continue
        e['count'] += 1
        e['addrs'].update(b['addrs'][:1])

    if a.quiet and not unmatched and not placeholder:
        return
    print(f"# {time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime())} scanned {a.fork}..{tip} "
          f"({fetched} fetched), list {len(pools)} entries, unmatched {len(unmatched)}, "
          f"address-only entries with a different coinbase tag {len(placeholder)}")
    for key, e in unmatched.items():
        print(f"  unmatched   {e['count']:3d} blocks  first {e['first']}  tag={key!r}  addresses={sorted(e['addrs'])}")
    for (pid, name, tag), e in placeholder.items():
        print(f"  named-by-addr {e['count']:3d} blocks  first {e['first']}  id {pid} {name!r}  coinbase tag={tag!r}  addresses={sorted(e['addrs'])}")


if __name__ == '__main__':
    main()
