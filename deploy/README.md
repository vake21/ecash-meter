# Deploying eCash Meter to a single VPS

Everything runs on one box: the eCash node, the indexer, the Next.js app, and
Caddy for TLS. Target domain: **example.com**.

> **Status.** The unit files, Caddy config, hardening and app deployment steps
> below were verified end to end on a real box. The **eCash mainnet node steps
> (3 and 5) have not been** — the previous deployment ran a different, far
> smaller chain. Treat the disk sizing and the assumeutxo flow as carefully
> reasoned but unproven, and run the checks in step 5 rather than trusting them.

## What runs here, and what doesn't

The app makes exactly four JSON-RPC calls — `getblockchaininfo`,
`getblockcount`, `getblockhash`, `getblock` (verbosity 3). **No wallet, no
`bip300301-enforcer`, no orchestrator.** The sidechain metadata table is in
`lib/config.ts`, so nothing needs the enforcer at runtime.

```
 eCash node (ECX mainnet, RPC on 127.0.0.1:8532)
     │  getblock v3
     ▼
 ecashmeter-index.timer → npm run index → /var/lib/ecashmeter/ecash-meter.sqlite
                                                    │  read-only
                                                    ▼
                                          ecashmeter.service (next start, :3000)
                                                    │
                                                    ▼
                                          Caddy :443 → example.com
```

The app never contacts the node, so the site keeps serving the last indexed data
even while the node is down or resyncing.

### Why a node at all

eCash publishes public Esplora endpoints (`esplora.ecash.com`,
`esplora.ecash.ninja`) which do expose per-transaction fees, so a node is not the
only conceivable source. The indexer speaks Bitcoin JSON-RPC, so running the node
keeps the data path first-party and unmetered. The store is also a local SQLite
file that `lib/store.ts` opens directly, so the web process must share a
filesystem with it either way.

## Forking this for your own deployment

There are no IP addresses, credentials or keys anywhere in this repository; every
secret is generated on the server in step 4. To run it under your own domain,
change these and nothing else:

1. **Your domain** — `deploy/Caddyfile` (both site blocks) and the
   `example.com` references here. The app never hardcodes a hostname.
2. **The clone URL** in step 6, and optionally the `Documentation=` lines in
   `deploy/systemd/*.service`.
3. **Nothing else.** The RPC password, `rpcauth` hash and TLS certificate are all
   generated fresh on your box.

### Branding assets are not included

The repository ships **code only** — no logo, favicon or background image, so the
artwork is not distributed under the code licence. Absent them the site renders a
styled text wordmark and a plain gradient background; nothing errors. To brand a
deployment, drop your own into place (they are gitignored, so `git pull` leaves
them alone):

| File | Purpose | Notes |
|------|---------|-------|
| `public/logo-dark.png` | header lockup, light-on-dark | any aspect ratio; rendered at 48–56px tall |
| `public/wallpaper.webp` | full-page background | keep it dark — see below |
| `app/icon.png` | favicon | square; Next picks it up automatically |

Presence is checked once at startup in `lib/branding.ts`, so add the files
**before** starting the service.

Footer links and the "project of X" credit are deployment-specific too, and live
in `site.local.json` (gitignored — copy `site.local.example.json`):

```json
{
  "learnLinks": [{ "label": "example.org", "href": "https://example.org/" }],
  "credit": { "label": "A Example project", "href": "https://example.org", "logo": "credit-logo.png" }
}
```

Both keys are optional; omit either and that part of the footer does not render.
`logo` is a bare filename inside `public/`. Only `http`/`https` hrefs are
accepted, and a malformed file is logged and ignored rather than taking the site
down. Read once at startup, so restart after editing.

Background artwork guidance, learned the hard way: the content column is a fixed
1024px centred, so on a 1440px viewport ~71% of the image sits behind text. Keep
mean luminance under ~10% and nothing above ~20% in that central band, or the
`.panel` surfaces stop reading as raised. Export WebP/AVIF under ~400KB with 1–2%
grain — dark gradients band badly in 8-bit, and a CSS background bypasses Next's
image optimizer.

One thing is *chain*-specific rather than deployment-specific:

- `lib/config.ts` holds the sidechain metadata table. ECX's registry entry
  publishes no slate yet, so the table is the ecosystem's published slot
  assignments. This does **not** gate what the dashboard shows — unnamed slots
  render as "Slot N" — it only supplies names and colours. Refresh it from
  `https://drivechain.dev/config` (`networks[].sidechains[]`) when ECX publishes
  one.

The service account names (`ecash`, `ecashmeter`) and paths (`/srv/ecashmeter`,
`/var/lib/ecashmeter`, `/var/lib/ecash`) are arbitrary — rename them if you like,
but change them consistently across `deploy/systemd/*` and the env files.

## Sizing — read this before provisioning

**ECX inherits Bitcoin's entire history.** It forks from Bitcoin's ledger at
height 973,728, so a node validating from genesis needs every Bitcoin block ever
mined: several hundred GB, growing. That is the single biggest constraint on this
deployment, and it is why step 5 uses eCash's assumeutxo snapshot.

What the snapshot does and does not save:

- **Does save time to usable.** Loading the published UTXO snapshot at height
  965,000 puts the node at a validated tip within the hour instead of days. The
  snapshot height is *below* the fork, so every post-fork block — all this app
  ever reads — is covered by the snapshot chainstate.
- **Does not save bandwidth.** A second chainstate still validates history from
  genesis in the background, downloading the whole chain. Budget for that
  transfer; it is well inside a typical VPS allowance but it is not free.
- **`prune=` bounds disk, not bandwidth.** It also caps how far back the store
  can ever be rebuilt, because verbosity-3 prevouts are unavailable for pruned
  blocks. Keep the horizon well past `WINDOW_DAYS` (30).

Rough disk budget, unpruned: snapshot file ~9.5 GB (deletable once loaded) +
mainnet UTXO chainstate + blocks from 965,000 onward + the full historical
backfill. Provision for the whole chain plus headroom, or set `prune=` and size
for the horizon you want.

Add swap regardless — `next build` can OOM on a small box, especially while the
node is syncing.

**Node version:** Node 24.x or newer, for `node:sqlite` unflagged. NodeSource
serves `nodistro` and Caddy's repo serves `any-version`, so neither depends on
the distro codename.

---

## 1. DNS at Namecheap

Domain List → **example.com** → Manage → Advanced DNS. **Delete the default
parking-page records first**, then add:

| Type | Host | Value | TTL |
|------|------|-------|-----|
| A | `@` | your server IPv4 | Automatic |
| AAAA | `@` | your server IPv6 | Automatic |
| CNAME | `www` | `example.com.` | Automatic |

Do this early — Caddy cannot issue a certificate until the A record resolves.
Check with `dig +short example.com` before step 8.

## 2. Base setup

```bash
ssh root@YOUR_IP

apt update && apt upgrade -y
apt install -y ufw git curl ca-certificates unzip

ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

ECX's P2P port 8533 stays closed inbound. The node only needs *outbound* access
to reach `seed.ecash.ninja:8533`.

```bash
# Service accounts, both without login shells.
adduser --system --group --home /var/lib/ecash ecash
adduser --system --group --home /srv/ecashmeter ecashmeter

mkdir -p /var/lib/ecash /etc/ecash /var/lib/ecashmeter /etc/ecashmeter
chown ecash:ecash /var/lib/ecash
chown ecashmeter:ecashmeter /var/lib/ecashmeter
chmod 750 /var/lib/ecashmeter
```

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

## 3. Install the eCash node

⚠ **Not Bitcoin Core.** ECX is a hard fork with its own consensus rules, network
magic (`eca5dcb7`) and ports; a bitcoincore.org binary will not follow this
chain. eCash ships its own `bitcoind`, based on Bitcoin Core 32.1.

`https://releases.ecash.com/index.json` lists every channel with its version and
per-file sha256 — read it rather than scraping the directory listing, and
re-check the pinned values below against it, since `mainnet` advances.

```bash
cd /tmp
V=1.2.0-core32.1
curl -O https://releases.ecash.com/L1-ecash-bitcoin/mainnet/$V/L1-ecash-bitcoin-$V-x86_64-unknown-linux-gnu.zip

# Verify before extracting. Checksum from releases.ecash.com/index.json.
echo "e5be8f86a72bf29b4f423e8a5917281eaf5004d6841e4c45ef511358952568b4  L1-ecash-bitcoin-$V-x86_64-unknown-linux-gnu.zip" | sha256sum -c -
# must print: OK

unzip -q L1-ecash-bitcoin-$V-x86_64-unknown-linux-gnu.zip
install -m 0755 L1-ecash-bitcoin-$V-*/bitcoind L1-ecash-bitcoin-$V-*/bitcoin-cli /usr/local/bin/
bitcoind --version | head -1   # expect: eCash daemon version ecash-v1.2.0-core32.1
```

If that version line says "Bitcoin Core" rather than "eCash", you have the wrong
binary and the node will sync Bitcoin instead of ECX.

## 4. Node config and RPC credentials

Copy `deploy/ecash.conf` to `/etc/ecash/ecash.conf` (note the filename — eCash's
daemon reads `ecash.conf`, not `bitcoin.conf`), then generate real credentials.
The binary tarball does not ship Core's `rpcauth.py`, so this reproduces it
exactly (random salt, HMAC-SHA256):

```bash
python3 - <<'EOF'
import os, hmac, hashlib, secrets
user = "ecashmeter"
pw   = secrets.token_urlsafe(32)
salt = os.urandom(16).hex()
h    = hmac.new(salt.encode(), pw.encode(), hashlib.sha256).hexdigest()
print(f"rpcauth={user}:{salt}${h}")
print(f"ECASH_RPC_PASS={pw}")
EOF
```

Put the `rpcauth=` line in `/etc/ecash/ecash.conf` (replacing `REPLACE_ME`) and
the password in `/etc/ecashmeter/indexer.env` at step 6. **Never** leave the
`user`/`password` defaults — `lib/rpc.ts` warns about them for good reason.

```bash
chown root:ecash /etc/ecash/ecash.conf && chmod 640 /etc/ecash/ecash.conf
```

## 5. Start the node, then load the snapshot

```bash
cp deploy/systemd/ecash-node.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ecash-node

alias ec='bitcoin-cli -conf=/etc/ecash/ecash.conf -datadir=/var/lib/ecash'
ec getblockchaininfo | grep -E "chain|blocks|headers"
```

Headers should climb immediately. Blocks will not — that is what the snapshot is
for.

### Load the assumeutxo snapshot

```bash
cd /var/lib/ecash
sudo -u ecash curl -O https://releases.ecash.com/assumeutxo/mainnet/utxo-965000.dat
echo "89351f7106051c0685880f9c64026e993335308de63ae6980e94ba3fafdc7dda  utxo-965000.dat" | sha256sum -c -
# must print: OK  — ~9.5 GB

ec loadtxoutset /var/lib/ecash/utxo-965000.dat
```

`loadtxoutset` blocks while it loads. Afterwards:

```bash
ec getchainstates
```

**Read this output honestly.** It reports two chainstates: the snapshot one at
the tip, and a background one still validating from genesis with
`validated: false`. `getblockchaininfo` will cheerfully report the tip with
`initialblockdownload: false` while history is still downloading underneath —
`getchainstates` is the only command that shows the real picture. Once the
background chainstate finishes, the snapshot file can be deleted.

### Verify the node identity and the data the indexer needs

```bash
# 1. Is this actually ECX? Genesis cannot tell you — it is Bitcoin's.
ec getblockhash 973728
# expect 0000000000000001441a6a4ae49d679d4a30581db3e3eaeeb2fba5da6dc146ed
```

The indexer performs exactly this check and refuses to run if it fails, so a
mismatch here means the binary or the config is wrong.

```bash
# 2. Does verbosity 3 still carry fees and prevouts on a snapshot-synced node?
#    This is the one unproven assumption in this runbook. Verbosity 3 reads
#    prevouts from block undo data, which exists only for blocks the node
#    actually connected.
ec getblock $(ec getblockhash $(( $(ec getblockcount) - 1 ))) 3 \
  | python3 -c 'import json,sys; b=json.load(sys.stdin); t=[x for x in b["tx"] if "fee" in x]; print("txs:",len(b["tx"]),"with fee:",len(t)); print("prevout ok:", any("prevout" in v for x in b["tx"][1:2] for v in x.get("vin",[])))'
```

If `with fee: 0`, **stop** — the indexer will silently attribute 0 sats to every
bid and the dashboard will under-report fees rather than fail loudly. Fix the
node (unpruned range, finished undo data) before indexing.

## 6. Deploy the app

```bash
# Clone AS ecashmeter. Cloning as root then chowning leaves git refusing to
# operate ("detected dubious ownership"), which breaks later `git pull`s.
mkdir -p /srv/ecashmeter && chown ecashmeter:ecashmeter /srv/ecashmeter
sudo -u ecashmeter git clone https://github.com/vake21/ecash-meter.git /srv/ecashmeter

curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
node -e "require('node:sqlite'); console.log('node:sqlite OK')"
```

If that last line throws, the Node version is too old. There is no fallback: the
store has no external database driver by design.

```bash
cd /srv/ecashmeter

# --include=dev is REQUIRED. The indexer runs through tsx, and next build needs
# typescript and tailwind — all devDependencies. `npm ci` would skip them if
# NODE_ENV=production is set in the shell.
sudo -u ecashmeter npm ci --include=dev
sudo -u ecashmeter npm run build
```

Install the env files:

```bash
cp deploy/site.env.example    /etc/ecashmeter/site.env
cp deploy/indexer.env.example /etc/ecashmeter/indexer.env
# edit indexer.env: set ECASH_RPC_PASS from step 4
chown root:ecashmeter /etc/ecashmeter/*.env && chmod 640 /etc/ecashmeter/*.env
```

## 7. First index, then the services

Install the units first, then run the backfill through the oneshot unit. Do NOT
use `env $(grep … | xargs)` — the generated RPC password is random and can
contain characters that word-splitting mangles, and the unit already reads the
EnvironmentFile correctly:

```bash
cp deploy/systemd/ecashmeter.service       /etc/systemd/system/
cp deploy/systemd/ecashmeter-index.service /etc/systemd/system/
cp deploy/systemd/ecashmeter-index.timer   /etc/systemd/system/
systemctl daemon-reload

systemctl start ecashmeter-index.service
journalctl -u ecashmeter-index -n 20 --no-pager -o cat
```

The first run backfills `ECASH_BACKFILL_BLOCKS` (10,000 by default, reaching back
past the fork) in chunks of `ECASH_INDEX_CHUNK`, logging `indexed to N of M` as it
goes. These are real mainnet blocks at verbosity 3, so expect minutes, not the
sub-second runs a tiny chain gives. If it refuses with a chain-identity or
parser-version message, it is telling you exactly what to fix.

```bash
systemctl enable --now ecashmeter.service
systemctl enable --now ecashmeter-index.timer   # the TIMER, not the .service

curl -s localhost:3000/api/health | python3 -m json.tool   # expect "status": "ok"
```

## 8. TLS and the public site

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy

cp deploy/Caddyfile /etc/caddy/Caddyfile
mkdir -p /var/log/caddy
caddy validate --config /etc/caddy/Caddyfile

# MUST come AFTER validate. Running `caddy validate` as root instantiates the file
# logger, creating /var/log/caddy/ecashmeter.log owned by root:root mode 600 — and
# the service runs as `caddy`, so it then fails to start with "permission denied"
# on that file. Chown the whole directory afterwards.
chown -R caddy:caddy /var/log/caddy

systemctl restart caddy
```

Certificate issuance takes a few seconds once DNS resolves. Then:

```bash
curl -sI https://example.com | head -1              # 200
curl -s https://example.com/api/health | python3 -m json.tool
curl -sI https://www.example.com | head -2          # 301 to apex
curl -sI --max-time 5 http://YOUR_IP:3000/            # must FAIL (loopback only)
```

---

## Operations

```bash
# logs
journalctl -u ecash-node -f
journalctl -u ecashmeter -f
journalctl -u ecashmeter-index --since "1 hour ago"
systemctl list-timers ecashmeter-index.timer

# is the data fresh? 503 = stale, empty, or parser mismatch
curl -s https://example.com/api/health | python3 -m json.tool

# is history still backfilling behind the snapshot?
bitcoin-cli -conf=/etc/ecash/ecash.conf -datadir=/var/lib/ecash getchainstates
```

Point an uptime monitor at `/api/health` and alert on non-200. It returns 503
when the newest indexed block is older than `STALE_AFTER_SEC` (30 min), which
catches a wedged indexer — a plain homepage check would not, because the page
renders happily from stale data.

**Redeploy:**

```bash
cd /srv/ecashmeter
sudo -u ecashmeter git pull
sudo -u ecashmeter npm ci --include=dev
sudo -u ecashmeter npm run build
systemctl restart ecashmeter
```

The store lives in `/var/lib/ecashmeter`, outside the app directory, so a
redeploy never touches it.

**Rebuild the store** (needed when `PARSER_VERSION` in `lib/bmm.ts` changes — the
indexer refuses to append across versions and tells you so):

```bash
systemctl stop ecashmeter-index.timer
rm /var/lib/ecashmeter/ecash-meter.sqlite*
systemctl start ecashmeter-index.service   # reads the EnvironmentFile properly
systemctl start ecashmeter-index.timer
```

The DB is a disposable derived cache; backing it up is optional. Rebuilding
re-fetches the backfill range from the node, which on mainnet is minutes rather
than instant — and it cannot reach further back than the node's prune horizon.
