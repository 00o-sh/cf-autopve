#!/usr/bin/env bash
# Exercise the bootstrap hook (build-iso.sh --print-bootstrap-hook) with the installer's own dhclient-script,
# dhclient.conf and busybox, on a fake LAN that has no DHCP server.
#
#   sudo test/iso-bootstrap.sh path/to/proxmox-ve_X.Y-Z.iso
#
# Needs root (network namespaces), dhclient, iproute2, xorriso, unsquashfs, zstd.
# Not part of `npm test`: it needs a real ISO and root.
set -euo pipefail

ISO="${1:?usage: $0 proxmox-ve.iso}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
W="$(mktemp -d)"
cleanup() {
  pkill -f "dhclient.*$W" 2>/dev/null || true
  ip netns del autopve-lan 2>/dev/null || true
  ip netns del autopve-node 2>/dev/null || true
  ip netns del autopve-node2 2>/dev/null || true
  rm -rf "$W"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

echo "== extracting the installer's dhclient pieces and busybox from $(basename "$ISO")"
xorriso -osirrox on -indev "$ISO" -extract /pve-installer.squashfs "$W/inst.sqfs" >/dev/null 2>&1
xorriso -osirrox on -indev "$ISO" -extract /pve-base.squashfs "$W/base.sqfs" >/dev/null 2>&1
unsquashfs -q -d "$W/inst" "$W/inst.sqfs" etc/dhcp usr/sbin/dhclient-script >/dev/null
unsquashfs -q -d "$W/base" "$W/base.sqfs" usr/bin/busybox >/dev/null
rm -f "$W"/*.sqfs
"$REPO/scripts/build-iso.sh" --print-bootstrap-hook >"$W/inst/etc/dhcp/dhclient-exit-hooks.d/zz-autopve-bootstrap"
mkdir -p "$W/bin"
for a in arping ping; do ln -s "$W/base/usr/bin/busybox" "$W/bin/$a"; done

cat >"$W/bootstrap.conf" <<'EOF'
range=10.66.0.240-10.66.0.242
prefix=24
gateway=10.66.0.1
dns=10.66.0.53 10.66.0.54
EOF

# LAN: the gateway, and nothing else answering DHCP.
ip netns add autopve-lan
ip -n autopve-lan link add br0 type bridge
ip -n autopve-lan link set br0 up
ip -n autopve-lan addr add 10.66.0.1/24 dev br0

add_node() { # name mac port
  ip netns add "$1"
  ip link add "$3" type veth peer name eth0 netns "$1"
  ip link set "$3" netns autopve-lan
  ip -n autopve-lan link set "$3" master br0 up
  ip -n "$1" link set eth0 address "$2"
  ip -n "$1" link set eth0 up
  ip -n "$1" link set lo up
}

run_dhclient() { # ns
  : >"$W/$1.resolv"
  ip netns exec "$1" unshare -m sh -c "
    mount -t tmpfs tmpfs /run
    mount --bind '$W/inst/etc/dhcp' /etc/dhcp
    touch /etc/autopve-bootstrap.conf 2>/dev/null || true
    mount --bind '$W/bootstrap.conf' /etc/autopve-bootstrap.conf
    mount --bind '$W/$1.resolv' /etc/resolv.conf
    export PATH='$W/bin':\$PATH
    dhclient -v -sf '$W/inst/usr/sbin/dhclient-script' -cf /etc/dhcp/dhclient.conf \
      -lf '$W/$1.leases' -pf '$W/$1.pid' 2>&1
    cp /run/autopve-bootstrap.log '$W/$1.log' 2>/dev/null || true
  " | sed 's/^/    /'
}

MAC=52:54:00:aa:bb:01
SLOT=$(( $(printf '%s' "$MAC" | cksum | cut -d' ' -f1) % 3 ))
TAKEN="10.66.0.$((240 + SLOT))"
NEXT="10.66.0.$((240 + (SLOT + 1) % 3))"
echo "== node1 ($MAC) prefers $TAKEN; occupying it so it must move on to $NEXT"
ip -n autopve-lan addr add "$TAKEN/24" dev br0

add_node autopve-node "$MAC" apve-p1
start=$(date +%s)
run_dhclient autopve-node
echo "   took $(( $(date +%s) - start ))s"

echo "== checks"
ip -n autopve-node -4 -o addr show dev eth0 | grep -q " $NEXT/24 " || fail "node1 did not get $NEXT: $(ip -n autopve-node -4 -o addr show dev eth0)"
echo "ok  node1 address $NEXT/24"
ip -n autopve-node -4 route show default | grep -q "via 10.66.0.1 dev eth0" || fail "no default route"
echo "ok  default route via 10.66.0.1"
diff <(printf 'nameserver 10.66.0.53\nnameserver 10.66.0.54\n') "$W/autopve-node.resolv" >/dev/null || fail "resolv.conf: $(cat "$W/autopve-node.resolv")"
echo "ok  resolv.conf nameservers"
ip netns exec autopve-node "$W/bin/ping" -c 1 -W 2 10.66.0.1 >/dev/null || fail "gateway not reachable"
echo "ok  gateway reachable"
grep -q "$TAKEN is in use" "$W/autopve-node.log" || fail "conflict was not detected"
echo "ok  skipped the address already in use"

echo "== node2 on a NIC whose 'gateway' never answers: must leave the NIC unconfigured"
ip netns add autopve-node2
ip -n autopve-node2 link add eth0 type veth peer name stub
ip -n autopve-node2 link set eth0 up; ip -n autopve-node2 link set stub up
run_dhclient autopve-node2
if ip -n autopve-node2 -4 -o addr show dev eth0 | grep -q inet; then fail "node2 kept an address without a gateway"; fi
grep -q "gateway 10.66.0.1 does not answer" "$W/autopve-node2.log" || fail "node2 log: $(cat "$W/autopve-node2.log" 2>/dev/null)"
echo "ok  wrong network left alone"

echo "PASS"
