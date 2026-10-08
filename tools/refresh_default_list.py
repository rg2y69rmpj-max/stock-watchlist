#!/usr/bin/env python3
"""Rebuild data/default-watchlist.json: the top N S&P 500 constituents by total market cap.

Usage (from the app folder):  python3 tools/refresh_default_list.py [N]

It reads two public pages: the S&P 500 constituent list (slickcharts.com/sp500) and the
global market-cap ranking (companiesmarketcap.com, first 3 pages). Both are scraped HTML,
so if either site changes its layout this script may need a small fix, or you can edit
the JSON by hand. Check the output before you commit it. It does not run in the app,
and the app never calls these sites.
"""
import datetime, html, json, os, re, sys, urllib.request

N = int(sys.argv[1]) if len(sys.argv) > 1 else 50
UA = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'}
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'default-watchlist.json')

def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
        return r.read().decode('utf-8', 'ignore')

def constituents():
    s, out = get('https://www.slickcharts.com/sp500'), {}
    for row in re.findall(r'<tr>(.*?)</tr>', s, re.S):
        cells = [html.unescape(re.sub(r'<[^>]+>', '', c).strip()) for c in re.findall(r'<td[^>]*>(.*?)</td>', row, re.S)]
        if len(cells) >= 4:
            out[cells[2]] = cells[1]
    if len(out) < 480:
        sys.exit('Constituent list looks wrong (%d rows); not writing.' % len(out))
    return out

def ranked():
    rows = []
    for page in (1, 2, 3):
        s = get('https://companiesmarketcap.com/page/%d/' % page)
        for row in re.findall(r'<tr>(.*?)</tr>', s, re.S):
            name = re.search(r'class="company-name">(.*?)<', row, re.S)
            code = re.search(r'class="company-code">(?:<span[^>]*></span>)?(.*?)<', row, re.S)
            cap = re.search(r'<td class="td-right" data-sort="(\d+)"><span class="currency', row)
            if name and code and cap:
                rows.append((html.unescape(name.group(1)).strip(), code.group(1).strip(), int(cap.group(1))))
    return sorted(rows, key=lambda r: -r[2])

def main():
    sp, picked = constituents(), []
    for name, code, cap in ranked():
        sym = code.replace('-', '.')
        if sym == 'GOOG':
            sym = 'GOOGL'  # one row per company
        if sym in sp and sym not in [p['symbol'] for p in picked]:
            picked.append({'symbol': sym, 'name': re.sub(r'\s*\((Google|Facebook)\)', '', name), 'marketCapUSD': cap})
        if len(picked) == N:
            break
    if len(picked) < N:
        sys.exit('Only matched %d symbols; not writing.' % len(picked))
    doc = {
        'asOf': datetime.date.today().isoformat(),
        'description': 'Top %d S&P 500 constituents by total market capitalisation, one ticker per company (Alphabet is listed once as GOOGL).' % N,
        'sources': ['Constituents: https://www.slickcharts.com/sp500', 'Market caps: https://companiesmarketcap.com/'],
        'note': 'marketCapUSD is a snapshot taken on asOf. The app only uses it to order rows until live market caps load; it is never shown as a live value.',
    }
    text = json.dumps(doc, indent=2, ensure_ascii=False)[:-2] + ',\n  "symbols": [\n'
    text += ',\n'.join('    ' + json.dumps(p, ensure_ascii=False) for p in picked) + '\n  ]\n}\n'
    json.loads(text)  # sanity check
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(text)
    print('Wrote %d symbols to %s' % (len(picked), os.path.relpath(OUT)))
    for i, p in enumerate(picked, 1):
        print('%2d %-6s %-32s $%.1fB' % (i, p['symbol'], p['name'], p['marketCapUSD'] / 1e9))

if __name__ == '__main__':
    main()
