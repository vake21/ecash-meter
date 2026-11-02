# Deploying eCash Meter to a single VPS

Everything runs on one box: the eCash node, the indexer, the Next.js app, and
Caddy for TLS. Target domain: **example.com**.

> **Status.** The unit files, Caddy config, hardening and app deployment steps
> below were verified end to end on a real box. The **eCash mainnet node steps
> (3 and 5) have not been** — the previous deployment ran a different, far
> smaller chain. Treat the disk sizing as carefully reasoned but unproven.
>
> One thing that WAS since verified against a real eCash node
> (`ecash-v1.2.0-core32.1`): `getblock <hash> 3` supplies per-transaction `fee`
> and `vin[].prevout.value`, which is what the fee attribution depends on. Block
> 300,000 returned 237 transactions, 236 carrying `fee` (the coinbase correctly
> has none) and prevout values present. So the indexer's core assumption holds on
> this build; the remaining unknowns are operational, not about the RPC.

> **Already running an older deployment?** These steps describe a fresh box.
> Converting a live signet deployment is a different sequence with a different
> ordering — see [Migrating an existing signet deployment to
> ECX](#migrating-an-existing-signet-deployment-to-ecx) at the end. The site can
> keep serving throughout, but only if you do it in that order.

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
mined: several hundred GB, growing. This deployment handles that by **pruning**,
which is cheap here for two reasons specific to this workload:

- The site reads a **rolling recent window only** — `WINDOW_DAYS` is 30 (~4,320
  blocks) and the indexer fetches only blocks newer than its stored tip. Nothing
  ever asks for an old block.
- It does **not** run `bip300301-enforcer`, which is what actually breaks under
  pruning (`Block not available`) on a full drivechain node.

`deploy/ecash.conf` sets `prune=40000`. Budget for an 80 GB disk:

| | |
|---|---|
| chainstate (~165.7M UTXOs) | ~12–15 GB |
| OS, Node, the Next build, swap | ~10 GB |
| blocks + undo at `prune=40000` | 40 GB |
| headroom | ~15 GB |

Measured against ECX on 2026-11-02 rather than assumed: ~614 blocks/day
(141 s/block) averaging 0.61 MB, so ~0.4 GB/day. 40 GB holds **~107 days**
against a 30-day display window. ECX runs faster than Bitcoin because the fork
reset difficulty, and the rate is still falling as difficulty settles, so that
horizon only grows. A 30-day window itself needs only ~11 GB.

**The sync still downloads the whole chain** — pruning deletes as it goes — so
budget bandwidth, not disk. Hetzner includes 20 TB. Expect days, not hours, on a
2-vCPU box.

### What pruning costs you

The prune horizon **caps how far back the store can ever be rebuilt**, because
verbosity-3 prevouts are unavailable for pruned blocks. That changes the SQLite
store from a throwaway derived cache into the only copy of your early history:
if `PARSER_VERSION` ever changes — which deliberately forces a rebuild — fee
history older than the horizon is gone.

**So back the store up.** It is small (~8 MB for 7,300 blocks). A nightly copy is
enough:

```bash
install -d -o ecashmeter -g ecashmeter /var/backups/ecashmeter
sudo -u ecashmeter sqlite3 /var/lib/ecashmeter/ecash-meter.sqlite \
  ".backup '/var/backups/ecashmeter/ecash-meter-$(date +%F).sqlite'"
```

Use `.backup`, not `cp` — the store is in WAL mode and a plain copy of a live
database can be torn.

### Not using the assumeutxo snapshot

eCash publishes a UTXO snapshot, and this runbook deliberately skips it:

- It would only shorten *time to usable*, not the download. Core still validates
  history from genesis in a background chainstate either way.
- It adds an untested interaction with pruning.
- **As of 2026-11-01 the published mainnet snapshot is unusable anyway**: its
  header carries Bitcoin mainnet's network magic (`f9beb4d9`) instead of eCash's
  (`eca5dcb7`), so `loadtxoutset` rejects it with "created for an unrecognized
  network". Reported upstream.

A plain pruned sync from genesis needs no babysitting.

**Node version:** Node 24.x or newer, for `node:sqlite` unflagged. NodeSource
serves `nodistro` and Caddy's repo serves `any-version`, so neither depends on
the distro codename.

---

## 0. Rehearse against a local node first

The VPS sync takes days. Finding a problem there, after waiting days, is the
expensive way to learn it — so point the indexer at a local ECX node first and
prove the pipeline end to end. Everything below needs a node synced **past the
fork at 973,728**; before that the indexer correctly declines with "node is at
height N, below the ECX fork".

Local nodes use cookie auth by default, and `lib/rpc.ts` speaks basic auth, which
is the same thing — Core's cookie file *is* a credential pair. In `.env.local`:

```bash
D=/path/to/your/ecash/datadir
ECASH_SOURCE=db
ECASH_METER_DB=.data/rehearsal.sqlite
ECASH_RPC_URL=http://127.0.0.1:8532          # 18302 under BitWindow
ECASH_RPC_USER=$(cut -d: -f1  "$D/.cookie")  # literally __cookie__
ECASH_RPC_PASS=$(cut -d: -f2- "$D/.cookie")
ECASH_BACKFILL_BLOCKS=20000                  # clamps to the fork anyway
ECASH_INDEX_CHUNK=100                        # smaller chunks on a laptop
```

**The cookie rotates on every node restart**, so if you restart the node
mid-rehearsal, re-read `.cookie` or the next run fails with `HTTP 401
Unauthorized`. The deployed box uses a static `rpcauth` instead, so this only
bites locally.

Then:

```bash
npm run index
```

Check each of these, because each covers something only unit tests have seen:

| Check | What it proves |
|---|---|
| It does not refuse with `network-mismatch` | the fork-block identity check passes against a real node |
| First run reports `from` = 973728 | the backfill clamps to the fork, not below it |
| It logs `indexed to N of M` several times | chunked commits are working on real, heavy blocks |
| `npm run index` again → `up to date` | incremental resume works |
| Store has commitments with `fee_sats > 0` | fee attribution survives real mainnet blocks |

```bash
sqlite3 .data/rehearsal.sqlite \
  "SELECT slot, COUNT(*) commitments, SUM(fee_sats) sats
     FROM commitments GROUP BY slot ORDER BY sats DESC;"
```

Cross-check the result against a block explorer before trusting it. As of
2026-11-01 ECX had exactly one merge-mined slot — 46 — with 73 commitments from
block 979,277 onward, and bids paying on the order of 378 sats, so a plausible
result is a single row. A row for a slot the explorer does not show, or a wildly
different total, means the parser and the chain disagree and the deploy should
wait.

Finally render it:

```bash
ECASH_METER_DB=.data/rehearsal.sqlite npm run dev
curl -s localhost:3000/api/health | python3 -m json.tool   # expect "status": "ok"
```

Health must report `"network": "ecx"` and a `chain.stored` equal to
`chain.expected`. Then delete `.data/rehearsal.sqlite` — the deployed store is
built on the server.

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

## 5. Start the node

```bash
cp deploy/systemd/ecash-node.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ecash-node

alias ec='bitcoin-cli -conf=/etc/ecash/ecash.conf -datadir=/var/lib/ecash'
watch -n30 'bitcoin-cli -conf=/etc/ecash/ecash.conf -datadir=/var/lib/ecash \
  getblockchaininfo | grep -E "blocks|headers|verificationprogress|pruned"'
```

Headers climb to the tip within minutes; blocks take days. Watch
`verificationprogress`, not `blocks` — ECX is at ~37% of blocks by the time it
is 5% through the actual work, because post-2017 blocks are far heavier. A
block-count extrapolation will lie to you.

### Verify the chain identity

```bash
ec getblockhash 973728
# expect 0000000000000001441a6a4ae49d679d4a30581db3e3eaeeb2fba5da6dc146ed
```

**Genesis cannot do this.** ECX inherits Bitcoin's genesis block byte for byte
and reports `chain: "main"`, so neither distinguishes it from a Bitcoin node.
The fork block can, because the fork resets difficulty. The indexer performs
exactly this check and refuses to run if it fails, so a mismatch means the
binary or the config is wrong — most likely a stock Bitcoin Core binary.

Until the node passes height 973,728 the indexer will decline with "node is at
height N, below the ECX fork", which is a "come back later", not an error.

### Confirm the data the indexer needs

Verbosity 3 must supply per-transaction fees and prevout values, since that is
what fee attribution reads:

```bash
ec getblock $(ec getblockhash 300000) 3 \
  | python3 -c 'import json,sys; b=json.load(sys.stdin); print("txs:",len(b["tx"]),"with fee:",len([t for t in b["tx"] if "fee" in t]))'
```

Verified on `ecash-v1.2.0-core32.1`: block 300,000 gives `txs: 237 with fee: 236`
(the coinbase has none) and prevout values present. If `with fee` comes back 0,
**stop** — the indexer would silently attribute 0 sats to every bid and the site
would under-report rather than fail.

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

The first run backfills from the fork (the floor clamps to 973,728) in chunks of
`ECASH_INDEX_CHUNK`, logging `indexed to N of M`. These are real mainnet blocks
at verbosity 3 — a few hundred MB of JSON per chunk — so budget **tens of
minutes**, not the sub-second runs a tiny chain gives. If it refuses with a
chain-identity or parser-version message, it is telling you exactly what to fix.

### Two settings that will otherwise time the backfill out

Both were learned the hard way against a real node, and both are about the
NODE's behaviour rather than the indexer's:

- **Keep `dbcache` modest.** A large UTXO cache only helps during IBD. Afterwards
  it is a liability: an oversized cache (`Cache size … exceeds total space` in
  `debug.log`) forces repeated full flushes, and flushing gigabytes to slow
  storage stalls *all* RPC for tens of seconds. A trivial `getblockhash` went
  from 15 ms to over 30 s this way, aborting the backfill. `deploy/ecash.conf`
  leaves `dbcache` unset so the node's own default applies.
- **Give `ECASH_RPC_TIMEOUT_MS` real headroom** — 120000 rather than the 30000
  default. Even a well-tuned node legitimately pauses to flush, and the backfill
  should ride that out instead of dying.

`ECASH_RPC_CONCURRENCY` (default 8) should stay below the node's `rpcthreads`
(default 10). Note that over-subscription was *not* what caused the timeouts
above — `dbcache` was — so raising concurrency is not the fix if you see stalls.

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

# is the node still catching up? watch verificationprogress, not blocks
bitcoin-cli -conf=/etc/ecash/ecash.conf -datadir=/var/lib/ecash \
  getblockchaininfo | grep -E "blocks|headers|verificationprogress|pruned|size_on_disk"

# back up the store — under pruning it is no longer rebuildable from the node
sudo -u ecashmeter sqlite3 /var/lib/ecashmeter/ecash-meter.sqlite \
  ".backup '/var/backups/ecashmeter/ecash-meter-$(date +%F).sqlite'"
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


---

# Migrating an existing signet deployment to ECX

The steps above describe a fresh box. Converting a *running* deployment is a
different sequence, and the ordering matters more than any individual command.

**The key fact that makes this nearly seamless:** the web app only ever reads
SQLite. It never contacts a node. So the existing site keeps serving its current
data, uninterrupted, for the days the new node spends syncing — provided you
leave the old node and indexer alone until the very end.

**The signet chain is tiny** (tens of MB) while a pruned ECX node is ~55 GB, so
both nodes fit on one 80 GB disk at the same time. That is what buys the
near-zero downtime. Check the arithmetic for your own box before relying on it,
and drop `prune` to `30000` if it is close.

## Three things that will bite you

1. **Do not deploy the new code while the old store is still the live one.**
   This codebase is ECX-only: the page header is hardcoded to `LIVE · ECX
   MAINNET`. Pointed at a signet store it would present signet data under an ECX
   label — wrong in the way that matters most for a site whose whole purpose is
   accurate reporting. `/api/health` would also return 503 `chain-mismatch`,
   because the store carries no ECX fork-block stamp. **Code and store switch
   together, last.**
2. **The indexer refuses to run below the fork.** Until the ECX node passes
   973,728 it reports "node is at height N, below the ECX fork" and stops. Do not
   mistake that for a failure; it is the identity guard.
3. **Archive the old store before you delete it.** Once you are on ECX-only
   code, the signet history is not readable or rebuildable by this codebase at
   all. If those months of commitments are worth keeping, copy the file off the
   box — it is the only copy.

## Sequence

**1. Add the ECX node alongside the existing one.** Do not touch the signet
node, the indexer timer, or the app. Install the eCash binary (step 3), put
`ecash.conf` at `/etc/ecash/ecash.conf` with its own datadir and `rpcauth`
(step 4), add `ecash-node.service`, and start it (step 5). The site carries on
serving signet throughout.

**2. Wait days.** Watch `verificationprogress`, not `blocks`. Meanwhile the
signet node and indexer keep the live site fresh.

**3. When the ECX node clears 973,728, rehearse into a separate store.** Use a
distinct `ECASH_METER_DB` path so the live signet store is untouched:

```bash
sudo -u ecashmeter env \
  ECASH_SOURCE=db \
  ECASH_METER_DB=/var/lib/ecashmeter/ecx.sqlite \
  ECASH_RPC_URL=http://127.0.0.1:8532 \
  ECASH_RPC_USER=ecashmeter ECASH_RPC_PASS=... \
  npm run index
```

Run the step 0 checks against `ecx.sqlite`. If anything disagrees with a block
explorer, stop — the live site is still fine, and you have lost nothing.

**4. Cut over.** Only now:

```bash
cp /var/lib/ecashmeter/ecash-meter.sqlite /root/signet-archive.sqlite   # keep it
systemctl stop ecashmeter-index.timer                                    # old indexer off

cd /srv/ecashmeter && sudo -u ecashmeter git pull
sudo -u ecashmeter npm ci --include=dev && sudo -u ecashmeter npm run build

# point both env files at the ECX store and the ECX node
sed -i 's#ecash-meter.sqlite#ecx.sqlite#' /etc/ecashmeter/site.env /etc/ecashmeter/indexer.env
sed -i 's#127.0.0.1:38332#127.0.0.1:8532#' /etc/ecashmeter/indexer.env

systemctl restart ecashmeter
systemctl start ecashmeter-index.timer
curl -s https://example.com/api/health | python3 -m json.tool
```

Health must show `"network": "ecx"`, `"status": "ok"`, and `chain.stored` equal
to `chain.expected`. Downtime is one `next start`, a few seconds.

**5. Remove signet.** Once ECX has been serving happily for a day:

```bash
systemctl disable --now bitcoind        # the old signet unit, whatever it is called
rm -rf /var/lib/bitcoind /etc/bitcoin
rm /var/lib/ecashmeter/ecash-meter.sqlite*   # archived in step 4
```

That reclaims the disk and leaves one node on the box.

## Rolling back

Until step 4 there is nothing to roll back — the live site never changed. After
step 4, `git checkout` the previous commit, point the env files back at the
signet store and node, rebuild, and restart. This is the reason step 4 archives
the old store rather than deleting it, and the reason signet is not removed until
a day later.
