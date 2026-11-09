#!/usr/bin/env python3
"""Install a pasted Treblo cookie jar at ~/.treblo-cookies.txt.

The browser export is space-separated (a Netscape jar is tab-separated) and
its values carry a "base64-" annotation that is not part of the cookie. The
Supabase auth cookie is chunked across sb-db-auth-token.0/.1, so the whole
token is also written as one cookie for the tools that do not speak
chunking.

    python3 tools/install-treblo-cookies.py <jar.txt>
"""

import base64
import json
import os
import pathlib
import sys
import time


def main(argv):
    src = pathlib.Path(argv[1] if len(argv) > 1 else (pathlib.Path.home() / '.treblo-cookies.txt'))
    dst = pathlib.Path.home() / '.treblo-cookies.txt'
    if not src.exists():
        print(f'no such file: {src}')
        return 2

    chunks = {}
    out = []
    for line in src.read_text().splitlines():
        if not line.strip():
            continue
        if line.startswith('#'):
            out.append(line)
            continue
        parts = line.split()
        if len(parts) != 7:
            continue
        domain, include_sub, path_, secure, expires, name, value = parts
        if value.startswith('base64-'):
            value = value[len('base64-'):]
        out.append('\t'.join([domain, include_sub, path_, secure, expires, name, value]))
        if name.startswith('sb-db-auth-token.'):
            chunks[name.rsplit('.', 1)[1]] = value

    session = None
    if chunks:
        # The auth cookie is chunked on the TEXT: each chunk is base64 of a
        # PIECE of the JSON, so the pieces are decoded and concatenated.
        text = ''
        for k in sorted(chunks, key=int):
            v = chunks[k]
            text += base64.b64decode(v + '=' * (-len(v) % 4)).decode('utf-8', 'replace')
        # The whole base64 value is also kept, for the single-cookie form.
        full = ''.join(chunks[k] for k in sorted(chunks, key=int))
        try:
            session = json.loads(text)
        except Exception as e:
            print(f'  the auth chunks do not decode: {e}')
        else:
            # one whole cookie for the tools that do not speak chunking
            if not any(l.split('\t')[5:6] == ['sb-db-auth-token'] for l in out if '\t' in l):
                expires = session.get('expires_at') or 0
                out.append('\t'.join(['treblo.com', 'FALSE', '/', 'FALSE', str(expires),
                                      'sb-db-auth-token', full]))

    dst.write_text('\n'.join(out) + '\n')
    dst.chmod(0o600)
    print(f'wrote {dst} ({dst.stat().st_size} bytes, mode 0600)')
    if session:
        user = session.get('user', {})
        exp = session.get('expires_at')
        print(f'  account : {user.get("email")} | {user.get("full_name") or user.get("name")}')
        print(f'  role    : {user.get("role")} | id {user.get("id")}')
        if exp:
            print(f'  expires : {time.strftime("%Y-%m-%d %H:%M", time.localtime(exp))}')
        print(f'  issued  : {(time.time() - session.get("issued_at", time.time())) / 60:.0f} min ago')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
