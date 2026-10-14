#!/usr/bin/env bash
# Build a Proxmox VE installer ISO that fetches its answer from autopve.
#
#   AUTOPVE_URL=https://autopve.example.com scripts/build-iso.sh            # newest PVE release
#   scripts/build-iso.sh --url https://autopve.example.com --version 9.2-1
#   scripts/build-iso.sh --url https://autopve.example.com --iso ./proxmox-ve_9.2-1.iso
#   scripts/build-iso.sh --url … --bootstrap-range 10.0.0.240-10.0.0.249/24 --bootstrap-gateway 10.0.0.1
#
# One ISO serves every node: the Worker picks the answer from the hardware the
# installer reports, so you only rebuild for a new PVE release or a new token.
#
# Needs curl and sha256sum. Uses proxmox-auto-install-assistant + xorriso when
# installed, otherwise runs them in a throwaway Debian container (docker or podman).
set -euo pipefail

ISO_MIRROR="https://enterprise.proxmox.com/iso"
URL="${AUTOPVE_URL:-}"
VERSION=""
ISO=""
OUT_DIR="./iso"
RUNNER="auto"
FIRST_BOOT=""
NO_TOKEN=0
TOKEN_IN_URL=0
SAFE_COPY=auto
BOOT_RANGE=""
BOOT_GW=""
BOOT_DNS=""

die() { echo "build-iso: $*" >&2; exit 1; }
say() { echo "==> $*" >&2; }

usage() {
  cat <<'EOF'
Usage: build-iso.sh [options]

  --url URL          autopve base URL, e.g. https://autopve.example.com  (or AUTOPVE_URL)
  --version X.Y-Z    PVE release to download, e.g. 9.2-1 (default: newest amd64 release)
  --iso PATH         use a local source ISO instead of downloading one
  --out DIR          where to put downloads and the result (default: ./iso)
  --first-boot FILE  bake a first-boot executable into the ISO (answer: first-boot.source = "from-iso")
  --no-token         the deployment has no SERVE_TOKEN
  --token-in-url     put the token in the answer URL even if the assistant can send it as an
                     Authorization header (the default when it supports --answer-auth-token)
  --bootstrap-range START-END/PREFIX
                     for networks without DHCP: if DHCP gets no answer, the installer takes a
                     free address from this range (e.g. 10.0.0.240-10.0.0.249/24) to fetch its
                     answer. The installed system's network still comes from the answer file:
                     give each machine network.source = "from-answer".
  --bootstrap-gateway IP   gateway for the bootstrap range (required with --bootstrap-range)
  --bootstrap-dns IP[,IP]  DNS servers for the bootstrap range (default: the gateway)
  --runner MODE      auto | native | docker | podman (default: auto)
  --safe-copy        copy the ISO with plain reads/writes (needs strace); on by default under WSL,
                     where the tool's in-kernel copy can fail with "Cannot allocate memory"
  -h, --help

The serve token is read from AUTOPVE_TOKEN, or prompted for (input hidden) so it
stays out of your shell history. It ends up inside the ISO: treat the ISO as secret.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2:?}"; shift 2 ;;
    --version) VERSION="${2:?}"; shift 2 ;;
    --iso) ISO="${2:?}"; shift 2 ;;
    --out) OUT_DIR="${2:?}"; shift 2 ;;
    --first-boot) FIRST_BOOT="${2:?}"; shift 2 ;;
    --no-token) NO_TOKEN=1; shift ;;
    --token-in-url) TOKEN_IN_URL=1; shift ;;
    --bootstrap-range) BOOT_RANGE="${2:?}"; shift 2 ;;
    --bootstrap-gateway) BOOT_GW="${2:?}"; shift 2 ;;
    --bootstrap-dns) BOOT_DNS="${2:?}"; shift 2 ;;
    --runner) RUNNER="${2:?}"; shift 2 ;;
    --safe-copy) SAFE_COPY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[ -n "$URL" ] || { usage >&2; die "--url (or AUTOPVE_URL) is required"; }
[ -z "$VERSION" ] || [ -z "$ISO" ] || die "use --version or --iso, not both"
command -v curl >/dev/null || die "curl is required"
command -v sha256sum >/dev/null || die "sha256sum is required"
[ -z "$FIRST_BOOT" ] || [ -f "$FIRST_BOOT" ] || die "first-boot file not found: $FIRST_BOOT"

# ------------------------------------------------------------ bootstrap network
is_ipv4() {
  local IFS=. o; local -a p
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  read -ra p <<<"$1"
  for o in "${p[@]}"; do [ $((10#$o)) -le 255 ] || return 1; done
}
ip2int() { local IFS=.; local -a p; read -ra p <<<"$1"; echo $(( (10#${p[0]} << 24) + (10#${p[1]} << 16) + (10#${p[2]} << 8) + 10#${p[3]} )); }

BOOTSTRAP_CONF=""
if [ -n "$BOOT_RANGE$BOOT_GW$BOOT_DNS" ]; then
  [ -n "$BOOT_RANGE" ] && [ -n "$BOOT_GW" ] || die "--bootstrap-range and --bootstrap-gateway go together"
  [[ "$BOOT_RANGE" =~ ^([0-9.]+)-([0-9.]+)/([0-9]+)$ ]] || die "--bootstrap-range must look like 10.0.0.240-10.0.0.249/24"
  B_START="${BASH_REMATCH[1]}"; B_END="${BASH_REMATCH[2]}"; B_PREFIX="${BASH_REMATCH[3]}"
  is_ipv4 "$B_START" && is_ipv4 "$B_END" || die "--bootstrap-range: not IPv4 addresses"
  [ "$B_PREFIX" -ge 1 ] && [ "$B_PREFIX" -le 32 ] || die "--bootstrap-range: prefix must be 1-32"
  is_ipv4 "$BOOT_GW" || die "--bootstrap-gateway: not an IPv4 address"
  [ "$(ip2int "$B_END")" -ge "$(ip2int "$B_START")" ] || die "--bootstrap-range: end is before start"
  B_MASK=$(( (0xffffffff << (32 - B_PREFIX)) & 0xffffffff ))
  for a in "$B_END" "$BOOT_GW"; do
    [ $(( $(ip2int "$a") & B_MASK )) -eq $(( $(ip2int "$B_START") & B_MASK )) ] || die "--bootstrap: $a is not in $B_START/$B_PREFIX"
  done
  BOOT_DNS="${BOOT_DNS:-$BOOT_GW}"
  for a in ${BOOT_DNS//,/ }; do is_ipv4 "$a" || die "--bootstrap-dns: $a is not an IPv4 address"; done
  BOOTSTRAP_CONF="range=$B_START-$B_END
prefix=$B_PREFIX
gateway=$BOOT_GW
dns=${BOOT_DNS//,/ }"
fi
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/iso"
[ -z "$BOOTSTRAP_CONF" ] || [ -f "$HOOK_DIR/autopve-bootstrap" ] || die "missing $HOOK_DIR/autopve-bootstrap"

# Accept https://host, https://host/ or https://host/answer.
URL="${URL%/}"; URL="${URL%/answer}"
case "$URL" in https://*) ;; http://*) say "warning: plain http; the Worker refuses credentials over http" ;; *) die "--url must start with https://" ;; esac

TOKEN=""
if [ "$NO_TOKEN" -eq 0 ]; then
  TOKEN="${AUTOPVE_TOKEN:-}"
  if [ -z "$TOKEN" ] && [ -t 0 ]; then
    read -rsp "SERVE_TOKEN (leave empty if the deployment has none): " TOKEN; echo >&2
  fi
  [ -n "$TOKEN" ] || say "no token given; building for a deployment without SERVE_TOKEN"
fi
# The token goes in an Authorization header when the assistant supports it
# (--answer-auth-token, PVE 9.2+): headers stay out of URLs and access logs.
# Older assistants only take a URL, so the token falls back to a path segment.
BASE_ANSWER_URL="$URL/answer"
ANSWER_URL="$URL/answer${TOKEN:+/$TOKEN}"
AUTH_TOKEN=""
[ -z "$TOKEN" ] || [ "$TOKEN_IN_URL" -eq 1 ] || AUTH_TOKEN="autopve:$TOKEN"

mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

# ----------------------------------------------------------------- source ISO
SUMS="$OUT_DIR/SHA256SUMS"
fetch_sums() { curl -fsSL "$ISO_MIRROR/SHA256SUMS" -o "$SUMS" || die "could not fetch $ISO_MIRROR/SHA256SUMS"; }

if [ -z "$ISO" ]; then
  fetch_sums
  if [ -z "$VERSION" ]; then
    VERSION="$(awk '{print $2}' "$SUMS" | sed -n 's/^proxmox-ve_\([0-9]*\.[0-9]*-[0-9]*\)\.iso$/\1/p' | sort -V | tail -1)"
    [ -n "$VERSION" ] || die "could not work out the newest release from SHA256SUMS"
    say "newest release is $VERSION"
  fi
  NAME="proxmox-ve_${VERSION}.iso"
  grep -q "  $NAME\$" "$SUMS" || die "$NAME is not on $ISO_MIRROR"
  ISO="$OUT_DIR/$NAME"
  if [ -f "$ISO" ] && (cd "$OUT_DIR" && grep "  $NAME\$" "$SUMS" | sha256sum -c --status -); then
    say "using cached $NAME"
  else
    say "downloading $NAME"
    curl -fL --progress-bar -C - "$ISO_MIRROR/$NAME" -o "$ISO" || die "download failed"
  fi
  say "verifying checksum"
  (cd "$OUT_DIR" && grep "  $NAME\$" "$SUMS" | sha256sum -c -) >&2 || die "checksum mismatch; delete $ISO and retry"
else
  [ -f "$ISO" ] || die "ISO not found: $ISO"
  ISO="$(cd "$(dirname "$ISO")" && pwd)/$(basename "$ISO")"
  NAME="$(basename "$ISO")"
  VERSION="$(printf '%s' "$NAME" | sed -n 's/^proxmox-ve_\([0-9]*\.[0-9]*-[0-9]*\)\.iso$/\1/p')"
  if [ -n "$VERSION" ]; then
    fetch_sums
    if grep -q "  $NAME\$" "$SUMS"; then
      say "verifying checksum"
      (cd "$(dirname "$ISO")" && grep "  $NAME\$" "$SUMS" | sha256sum -c -) >&2 || die "checksum mismatch for $NAME"
    fi
  else
    say "warning: $NAME is not an official file name; skipping checksum"
  fi
fi

case "${VERSION%%.*}" in
  8) SUITE=bookworm; KEY_URL="https://enterprise.proxmox.com/debian/proxmox-release-bookworm.gpg" ;;
  9|"") SUITE=trixie; KEY_URL="https://enterprise.proxmox.com/debian/proxmox-archive-keyring-trixie.gpg" ;;
  *) die "unsupported PVE major version: $VERSION" ;;
esac

OUTPUT="$OUT_DIR/${NAME%.iso}-autopve.iso"
rm -f "$OUTPUT"

# --------------------------------------------------------------------- runner
if [ "$RUNNER" = auto ]; then
  if command -v proxmox-auto-install-assistant >/dev/null && command -v xorriso >/dev/null; then RUNNER=native
  elif command -v docker >/dev/null && docker info >/dev/null 2>&1; then RUNNER=docker
  elif command -v podman >/dev/null; then RUNNER=podman
  else
    die "need proxmox-auto-install-assistant and xorriso (Debian with the Proxmox repo), or docker/podman.
  On Debian $SUITE:  see https://pve.proxmox.com/wiki/Package_Repositories, then
                     apt install proxmox-auto-install-assistant xorriso"
  fi
fi

# prepare-iso copies the ISO with copy_file_range in 1 GiB chunks and treats
# ENOMEM as fatal. WSL2 kernels return ENOMEM there under memory pressure, so
# there we make copy_file_range and sendfile report ENOSYS: the tool then falls
# back to plain reads and writes. The result is the same ISO.
# On arm64, strace cannot skip a syscall outright (it prints "arch_set_scno ...
# Invalid argument"): the call still runs and only its result is replaced. That
# is still safe, because both calls use the file positions and the fallback
# carries on from wherever the kernel copy stopped. The warnings are dropped.
if [ "$SAFE_COPY" = auto ]; then
  if grep -qiE 'microsoft|wsl' /proc/sys/kernel/osrelease 2>/dev/null; then SAFE_COPY=1; else SAFE_COPY=0; fi
fi
COPY_WRAP=()
if [ "$SAFE_COPY" = 1 ]; then
  COPY_WRAP=(strace -f -qq -o /dev/null -e "trace=copy_file_range,sendfile"
             -e inject=copy_file_range:error=ENOSYS -e inject=sendfile:error=ENOSYS)
  if [ "$RUNNER" = native ]; then
    command -v strace >/dev/null || die "safe copy (on by default under WSL) needs strace: sudo apt install strace"
  fi
  say "safe copy on: avoiding in-kernel file copies"
fi
export AUTOPVE_SAFE_COPY="$SAFE_COPY"

# The answer URL and token travel as environment variables so the token is
# not visible in docker's process list; the container gets them by name only.
export AUTOPVE_ANSWER_URL="$ANSWER_URL" AUTOPVE_BASE_ANSWER_URL="$BASE_ANSWER_URL" AUTOPVE_AUTH_TOKEN="$AUTH_TOKEN"
ISO_DIR="$(dirname "$ISO")"
FB_ARGS=()

# Sets FETCH_ARGS from what the installed assistant supports. Kept as text so
# the container runs the identical logic.
# shellcheck disable=SC2089,SC2090 # code as text, run with eval on both sides
PICK_FETCH='
FETCH_ARGS=(--url "$AUTOPVE_ANSWER_URL")
if [ -n "$AUTOPVE_AUTH_TOKEN" ]; then
  if proxmox-auto-install-assistant prepare-iso --help 2>&1 | grep -q -- --answer-auth-token; then
    FETCH_ARGS=(--url "$AUTOPVE_BASE_ANSWER_URL" --answer-auth-token "$AUTOPVE_AUTH_TOKEN")
    echo "==> token sent as an Authorization header; answer URL ${AUTOPVE_BASE_ANSWER_URL}" >&2
  else
    echo "==> this assistant has no --answer-auth-token; token goes in the answer URL instead" >&2
  fi
fi
if [ "${FETCH_ARGS[2]:-}" != --answer-auth-token ]; then
  if [ "$AUTOPVE_ANSWER_URL" = "$AUTOPVE_BASE_ANSWER_URL" ]; then echo "==> answer URL $AUTOPVE_BASE_ANSWER_URL" >&2
  else echo "==> answer URL $AUTOPVE_BASE_ANSWER_URL/<token>" >&2; fi
fi
'
# shellcheck disable=SC2090
export PICK_FETCH

# Appends a small archive to the ISO's initrd: the bootstrap hook + its config,
# and a copy of the initrd's /init with one added line that copies them into
# the installer's root before it starts. The kernel unpacks appended archives
# in order and later files replace earlier ones, so the stock initrd is left
# intact. The ISO is edited in place the way prepare-iso does it: same boot
# records, same volume UUID (the installer finds its medium by that UUID).
# shellcheck disable=SC2089 # code as text, run with eval on both sides
INJECT_BOOTSTRAP='
inject_bootstrap() {
  local iso="$1" w uuid anchor
  anchor="    cp /.cd-info /mnt/.installer-mp/ || true"
  w=$(mktemp -d)
  local report geometry=()
  report=$(xorriso -dev "$iso" -report_system_area cmd 2>/dev/null)
  uuid=$(printf "%s\n" "$report" | sed -n "s/^-volume_date uuid .\([0-9]*\).*/\1/p")
  [ -n "$uuid" ] || { echo "build-iso: could not read the ISO volume UUID" >&2; return 1; }
  # A second xorriso pass would otherwise recompute the hybrid MBR geometry.
  # Carry it over so the boot records stay exactly as prepare-iso wrote them.
  for g in $(printf "%s\n" "$report" | sed -n "s/^-boot_image any \(partition_hd_cyl=[0-9]*\|partition_sec_hd=[0-9]*\)$/\1/p"); do
    geometry+=(-boot_image any "$g")
  done
  xorriso -osirrox on -indev "$iso" -extract /boot/initrd.img "$w/initrd.img" >/dev/null 2>&1 \
    || { echo "build-iso: could not extract /boot/initrd.img" >&2; return 1; }
  mkdir -p "$w/x" "$w/add/autopve-overlay/etc/dhcp/dhclient-exit-hooks.d"
  (cd "$w/x" && zstd -dcq ../initrd.img | cpio -id --quiet init) \
    || { echo "build-iso: could not unpack the initrd" >&2; return 1; }
  if [ "$(grep -cxF "$anchor" "$w/x/init")" != 1 ]; then
    echo "build-iso: this ISO'"'"'s installer init is not one --bootstrap-range knows how to extend; build without it" >&2
    return 1
  fi
  awk -v a="$anchor" "{ print } \$0 == a { print \"    cp -a /autopve-overlay/. /mnt/.installer-mp/ 2>/dev/null || true # autopve: bootstrap network\" }" \
    "$w/x/init" >"$w/add/init"
  chmod 0755 "$w/add/init"
  install -m 0644 "$AUTOPVE_HOOK_FILE" "$w/add/autopve-overlay/etc/dhcp/dhclient-exit-hooks.d/zz-autopve-bootstrap"
  printf "%s\n" "$AUTOPVE_BOOTSTRAP_CONF" >"$w/add/autopve-overlay/etc/autopve-bootstrap.conf"
  chmod 0644 "$w/add/autopve-overlay/etc/autopve-bootstrap.conf"
  (cd "$w/add" && find . -mindepth 1 | sed "s|^\./||" | LC_ALL=C sort | cpio -o -H newc -R 0:0 --quiet | zstd -19 -q) >"$w/extra.cpio.zst"
  cat "$w/initrd.img" "$w/extra.cpio.zst" >"$w/initrd.new"
  xorriso -boot_image any keep "${geometry[@]}" -volume_date uuid "$uuid" -dev "$iso" -map "$w/initrd.new" /boot/initrd.img >/dev/null 2>&1 \
    || { echo "build-iso: could not write the new initrd into the ISO" >&2; return 1; }
  rm -rf "$w"
  echo "==> bootstrap network added: $(printf "%s" "$AUTOPVE_BOOTSTRAP_CONF" | tr "\n" " ")" >&2
}
'
# shellcheck disable=SC2090
export INJECT_BOOTSTRAP AUTOPVE_BOOTSTRAP_CONF="$BOOTSTRAP_CONF"

say "building with $RUNNER"
case "$RUNNER" in
  native)
    [ -z "$FIRST_BOOT" ] || FB_ARGS=(--on-first-boot "$FIRST_BOOT")
    eval "$PICK_FETCH"
    ${COPY_WRAP[@]+"${COPY_WRAP[@]}"} proxmox-auto-install-assistant prepare-iso "$ISO" --fetch-from http \
      "${FETCH_ARGS[@]}" --output "$OUTPUT" ${FB_ARGS[@]+"${FB_ARGS[@]}"} \
      2>&1 | { grep -v --line-buffered 'arch_set_scno' || true; }
    if [ -n "$BOOTSTRAP_CONF" ]; then
      for t in zstd cpio; do command -v "$t" >/dev/null || die "--bootstrap-range needs $t: sudo apt install $t"; done
      export AUTOPVE_HOOK_FILE="$HOOK_DIR/autopve-bootstrap"
      eval "$INJECT_BOOTSTRAP"
      inject_bootstrap "$OUTPUT" || die "adding the bootstrap network failed"
    fi
    ;;
  docker|podman)
    MOUNTS=(-v "$ISO_DIR:/src:ro" -v "$OUT_DIR:/out")
    [ -z "$BOOTSTRAP_CONF" ] || MOUNTS+=(-v "$HOOK_DIR:/autopve-iso:ro")
    if [ -n "$FIRST_BOOT" ]; then
      MOUNTS+=(-v "$(cd "$(dirname "$FIRST_BOOT")" && pwd)/$(basename "$FIRST_BOOT"):/first-boot:ro")
      FB_ARGS=(--on-first-boot /first-boot)
    fi
    # shellcheck disable=SC2016  # expands inside the container, not here
    "$RUNNER" run --rm -e AUTOPVE_ANSWER_URL -e AUTOPVE_BASE_ANSWER_URL -e AUTOPVE_AUTH_TOKEN -e PICK_FETCH -e AUTOPVE_SAFE_COPY \
      -e INJECT_BOOTSTRAP -e AUTOPVE_BOOTSTRAP_CONF -e AUTOPVE_HOOK_FILE=/autopve-iso/autopve-bootstrap "${MOUNTS[@]}" "docker.io/library/debian:$SUITE" bash -euo pipefail -c '
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq >/dev/null
      apt-get install -y -qq --no-install-recommends ca-certificates curl xorriso strace zstd cpio >/dev/null
      curl -fsSL "$1" -o /usr/share/keyrings/proxmox.gpg
      echo "deb [signed-by=/usr/share/keyrings/proxmox.gpg] http://download.proxmox.com/debian/pve $2 pve-no-subscription" \
        > /etc/apt/sources.list.d/pve.list
      apt-get update -qq >/dev/null
      apt-get install -y -qq --no-install-recommends proxmox-auto-install-assistant >/dev/null
      src="$0" out="$3"; shift 3
      wrap=()
      [ "$AUTOPVE_SAFE_COPY" != 1 ] || wrap=(strace -f -qq -o /dev/null -e trace=copy_file_range,sendfile \
        -e inject=copy_file_range:error=ENOSYS -e inject=sendfile:error=ENOSYS)
      eval "$PICK_FETCH"
      ${wrap[@]+"${wrap[@]}"} proxmox-auto-install-assistant prepare-iso "/src/$src" --fetch-from http \
        "${FETCH_ARGS[@]}" --output "/out/$out" --tmp /out "$@" \
        2>&1 | { grep -v --line-buffered arch_set_scno || true; }
      if [ -n "$AUTOPVE_BOOTSTRAP_CONF" ]; then
        eval "$INJECT_BOOTSTRAP"
        inject_bootstrap "/out/$out"
      fi
    ' "$NAME" "$KEY_URL" "$SUITE" "$(basename "$OUTPUT")" ${FB_ARGS[@]+"${FB_ARGS[@]}"}
    ;;
  *) die "unknown runner: $RUNNER" ;;
esac

[ -f "$OUTPUT" ] || die "prepare-iso finished but $OUTPUT is missing"
chmod 600 "$OUTPUT"
say "done: $OUTPUT"
sha256sum "$OUTPUT" >&2
cat >&2 <<EOF

Next:
  * Write it to USB or attach it as virtual media (iDRAC/IPMI) and boot.
  * Answers holding a root password are only served while armed: arm the
    answer in the configurator just before you boot.
  * The ISO contains the serve token. Keep it off shared drives.
EOF
[ -z "$BOOTSTRAP_CONF" ] || cat >&2 <<EOF
  * Without DHCP, the installer uses an address from $BOOT_RANGE to fetch its
    answer. Each machine's answer should set network.source = "from-answer"
    with its own cidr/gateway/dns; "from-dhcp" would keep the bootstrap address.
EOF
