#!/usr/bin/env bash
# Turn an ISO from build-iso.sh into iPXE network-boot files, optionally uploaded to R2.
#
#   scripts/build-pxe.sh --iso iso/proxmox-ve_9.2-1-autopve.iso --base-url https://assets.example.com/pxe
#   scripts/build-pxe.sh --iso … --base-url https://assets.example.com/pxe \
#     --upload s3://assets/pxe --r2-account <account id> --profile r2
#
# The Proxmox ISO is not built for network boot, so this uses the usual
# workaround: the kernel and initrd come out of the ISO, and the whole ISO is
# appended to the initrd as /proxmox.iso, where the installer finds it when no
# CD is present. The kernel options are copied from the ISO's "(Automated)"
# GRUB entry, so the result starts the automated install like the ISO does.
#
# Writes linux26, initrd-pxe.img and boot.ipxe to --out. Boot with iPXE:
#   chain <base-url>/boot.ipxe
# The initrd holds the whole ISO (about 1.7 GB, loaded into RAM), and with it
# the serve token: these files are as secret as the ISO. Keep per-answer IP
# allowlists on answers that hold credentials.
#
# Needs xorriso and cpio; --upload also needs the aws CLI.
set -euo pipefail

die() { echo "build-pxe: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: build-pxe.sh --iso PATH --base-url URL [options]

  --iso PATH          ISO made by build-iso.sh (must have the "(Automated)" boot entry)
  --base-url URL      where the files will be served from, e.g. https://assets.example.com/pxe
  --out DIR           where to write the files (default: ./pxe)
  --upload S3URL      upload the three files there with the aws CLI, e.g. s3://assets/pxe
  --r2-account ID     Cloudflare account ID: uploads go to its R2 S3 endpoint
  --endpoint URL      any other S3 endpoint for --upload (instead of --r2-account)
  --profile NAME      aws CLI profile for --upload (default: the CLI's own default)
  -h, --help
EOF
}

ISO="" BASE_URL="" OUT_DIR="./pxe" UPLOAD="" ENDPOINT="" PROFILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --iso) ISO="${2:?}"; shift 2 ;;
    --base-url) BASE_URL="${2:?}"; shift 2 ;;
    --out) OUT_DIR="${2:?}"; shift 2 ;;
    --upload) UPLOAD="${2:?}"; shift 2 ;;
    --r2-account) ENDPOINT="https://${2:?}.r2.cloudflarestorage.com"; shift 2 ;;
    --endpoint) ENDPOINT="${2:?}"; shift 2 ;;
    --profile) PROFILE="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[ -n "$ISO" ] || { usage >&2; die "--iso is required"; }
[ -f "$ISO" ] || die "ISO not found: $ISO"
[ -n "$BASE_URL" ] || { usage >&2; die "--base-url is required"; }
BASE_URL="${BASE_URL%/}"
case "$BASE_URL" in https://*|http://*) ;; *) die "--base-url must start with https:// or http://" ;; esac
for t in xorriso cpio; do command -v "$t" >/dev/null || die "$t is required (apt-get install $t)"; done
[ -z "$UPLOAD" ] || command -v aws >/dev/null || die "--upload needs the aws CLI"
case "$UPLOAD" in ""|s3://*) ;; *) die "--upload must be an s3:// URL" ;; esac

# The initrd carries the serve token: keep everything owner-only.
umask 077
mkdir -p "$OUT_DIR"
work="$(mktemp -d "$OUT_DIR/.build.XXXXXX")"
trap 'rm -rf "$work"' EXIT

echo "==> extracting kernel, initrd and grub.cfg" >&2
xorriso -osirrox on -indev "$ISO" \
  -extract /boot/linux26 "$work/linux26" \
  -extract /boot/initrd.img "$work/initrd.img" \
  -extract /boot/grub/grub.cfg "$work/grub.cfg" >/dev/null 2>&1 \
  || die "could not extract /boot/linux26, /boot/initrd.img and /boot/grub/grub.cfg from $ISO"
chmod 600 "$work"/*

# The first "(Automated)" entry's linux line, minus the keyword and the kernel path.
args="$(awk '/menuentry .*Automated/ { f = 1 } f && $1 == "linux" { $1 = ""; $2 = ""; sub(/^ +/, ""); print; exit }' "$work/grub.cfg")"
[ -n "$args" ] || die "no \"(Automated)\" entry in the ISO's grub.cfg: build it with build-iso.sh first"
echo "==> kernel options: $args" >&2

echo "==> appending the ISO to the initrd as /proxmox.iso" >&2
# cpio stores the name it is given, so the ISO must sit at that name in the cwd.
ln -s "$(realpath "$ISO")" "$work/proxmox.iso"
(cd "$work" && echo proxmox.iso | cpio -H newc -o -L --quiet >iso.cpio) || die "cpio failed"
# The kernel unpacks concatenated initramfs archives in order, compressed or not.
cat "$work/initrd.img" "$work/iso.cpio" >"$work/initrd-pxe.img"

cat >"$work/boot.ipxe" <<EOF
#!ipxe
dhcp
kernel ${BASE_URL}/linux26 initrd=initrd-pxe.img ${args}
initrd ${BASE_URL}/initrd-pxe.img
boot
EOF

for f in linux26 initrd-pxe.img boot.ipxe; do mv -f "$work/$f" "$OUT_DIR/$f"; done
echo "==> wrote $OUT_DIR/linux26, $OUT_DIR/initrd-pxe.img and $OUT_DIR/boot.ipxe" >&2

if [ -n "$UPLOAD" ]; then
  aws_args=()
  [ -z "$ENDPOINT" ] || aws_args+=(--endpoint-url "$ENDPOINT")
  [ -z "$PROFILE" ] || aws_args+=(--profile "$PROFILE")
  # Newer aws CLIs send checksum headers that R2 can reject.
  export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
  for f in linux26 initrd-pxe.img boot.ipxe; do
    echo "==> uploading $f to ${UPLOAD%/}/$f" >&2
    aws s3 cp "$OUT_DIR/$f" "${UPLOAD%/}/$f" ${aws_args[@]+"${aws_args[@]}"} || die "upload of $f failed"
  done
fi

echo "==> boot with iPXE:  chain ${BASE_URL}/boot.ipxe" >&2
