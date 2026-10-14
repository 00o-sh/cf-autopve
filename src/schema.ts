/**
 * Answer-file key catalogue, ported from autopve/tabs/settings.py.
 *
 * Every key the Proxmox automated installer understands is described here once
 * and reused by the API (validation, secret classification) and by the UI
 * (pulldowns, help text). Keys not in the catalogue are still allowed — the
 * upstream app lets you type a unique key and so does this one.
 */

import { COUNTRIES, TIMEZONES } from "./geo";
import type { Format } from "./validate";

export type KeyType = "str" | "int" | "bool" | "list";

export interface KeyDef {
  description: string;
  /** The complete set of accepted values; the UI offers them as a searchable dropdown. */
  options?: string[];
  /** Display names for options, shown next to the value in the dropdown. */
  labels?: Record<string, string>;
  /** Shape the value must have (see validate.ts). */
  format?: Format;
  type?: KeyType;
  /** Value is a credential: encrypted at rest, redacted everywhere, gated on serve. */
  secret?: boolean;
  /** Not a credential, but still identifying/sensitive: redacted in previews. */
  sensitive?: boolean;
}

export interface SectionDef {
  /** TOML table name. */
  id: string;
  /** Label in the UI. */
  label: string;
  keys: Record<string, KeyDef>;
  /** Free-form keys (NIC pinning MAC -> name mapping). */
  freeform?: boolean;
  help?: string;
}

const GLOBAL: Record<string, KeyDef> = {
  keyboard: {
    description: "The keyboard layout with the following possible options",
    options: [
      "de", "de-ch", "dk", "en-gb", "en-us", "es", "fi", "fr", "fr-be", "fr-ca",
      "fr-ch", "hu", "is", "it", "jp", "lt", "mk", "nl", "no", "pl", "pt",
      "pt-br", "se", "si", "tr",
    ],
    labels: {
      de: "German", "de-ch": "Swiss-German", dk: "Danish", "en-gb": "United Kingdom", "en-us": "U.S. English",
      es: "Spanish", fi: "Finnish", fr: "French", "fr-be": "Belgium-French", "fr-ca": "Canada-French",
      "fr-ch": "Swiss-French", hu: "Hungarian", is: "Icelandic", it: "Italian", jp: "Japanese", lt: "Lithuanian",
      mk: "Macedonian", nl: "Dutch", no: "Norwegian", pl: "Polish", pt: "Portuguese", "pt-br": "Brazil-Portuguese",
      se: "Swedish", si: "Slovenian", tr: "Turkish",
    },
  },
  country: {
    description: "The country code in the two letter variant. For example, at, us or fr.",
    options: Object.keys(COUNTRIES),
    labels: COUNTRIES,
  },
  fqdn: {
    description: "The fully qualified domain name of the host. The domain part will be used as the search domain.",
    format: "fqdn",
  },
  "fqdn.source": {
    description:
      "Must be set to 'from-dhcp'. Retrieves the host name (option 12) and, if available, domain name (option 15) from the DHCP lease configuration. In this mode, the DHCP server must provide a host name, otherwise the installation will fail.",
    options: ["from-dhcp"],
  },
  "fqdn.domain": { description: "Fallback (search) domain name to use if the DHCP server does not provide one.", format: "domain" },
  mailto: { description: "The default email address for the user root.", format: "email" },
  timezone: { description: "The timezone in tzdata format. For example, Europe/Vienna or America/New_York.", options: TIMEZONES },
  "root-password": {
    description:
      "The password for the root user. Stored encrypted; hosting it means anything that can reach the answer endpoint can read it. Prefer root-password-hashed.",
    type: "str",
    secret: true,
  },
  "root-password-hashed": {
    description:
      "The pre-hashed password for the root user, which will be written verbatim to /etc/passwd. May be used instead of root-password and can be generated using the mkpasswd tool, for example. Still a credential: offline-crackable, so it is treated as a secret.",
    type: "str",
    secret: true,
  },
  "root-ssh-keys": {
    description: "Optional. SSH public keys to add to the root users authorized_keys file after the installation.",
    type: "list",
    sensitive: true,
  },
  "reboot-on-error": {
    description:
      "If set to true, the installer will reboot automatically when an error is encountered. The default behavior is to wait to give the administrator a chance to investigate why the installation failed.",
    type: "bool",
    options: ["true", "false"],
  },
  "reboot-mode": {
    description:
      "Optional. Specifies whether the target machine should be rebooted or powered off after a successful installation. Options are reboot (default) and power-off.",
    options: ["reboot", "power-off"],
  },
  "subscription-key": {
    description:
      "Optional (PVE 9.2+). A Proxmox VE, Backup Server or Mail Gateway subscription key, staged during the install and activated on first boot once the network is up. Implies installing proxmox-first-boot. Treated as a credential.",
    type: "str",
    secret: true,
  },
};

/** Useful udev properties for picking the NIC (any udev property works as filter.<NAME>). */
const NIC_FILTERS: Record<string, KeyDef> = {
  "filter.ID_NET_NAME_MAC": { description: "Match the NIC by its MAC-based name, e.g. enx248a071e05bc. Globs * ? [abc] [!a] are allowed. Only the first matching NIC is used." },
  "filter.ID_NET_NAME": { description: "Match the NIC by its predictable interface name, e.g. enp1s0*. Globs allowed. Only the first matching NIC is used." },
  "filter.ID_VENDOR_FROM_DATABASE": { description: "Match the NIC by vendor name from the hwdb, e.g. Intel*. Globs allowed." },
  "filter.ID_MODEL_FROM_DATABASE": { description: "Match the NIC by model name from the hwdb, e.g. *X710*. Globs allowed." },
};

/** Useful udev properties for picking disks (any udev property works as filter.<NAME>). */
const DISK_FILTERS: Record<string, KeyDef> = {
  "filter.DEVNAME": { description: "Match disks by device node, e.g. /dev/nvme*. Globs * ? [abc] [!a] are allowed. Cannot be combined with disk-list." },
  "filter.ID_SERIAL": { description: "Match disks by full serial, e.g. KIOXIA_KCMYXVUG1T60*. Globs allowed. Cannot be combined with disk-list." },
  "filter.ID_SERIAL_SHORT": { description: "Match disks by short serial number. Globs allowed. Cannot be combined with disk-list." },
  "filter.ID_MODEL": { description: "Match disks by model, e.g. Samsung SSD 870*. Globs allowed. Cannot be combined with disk-list." },
  "filter.ID_WWN": { description: "Match disks by World Wide Name, e.g. eui.0100*. Globs allowed. Cannot be combined with disk-list." },
};

const NETWORK: Record<string, KeyDef> = {
  source: {
    description: "Where to source the static network configuration from. This can be from-dhcp or from-answer.",
    options: ["from-dhcp", "from-answer"],
  },
  cidr: { description: "The IP address in CIDR notation. For example, 192.168.1.10/24.", format: "cidr" },
  dns: { description: "The IP address of the DNS server.", format: "ip" },
  gateway: { description: "The IP address of the default gateway.", format: "ip" },
  ...NIC_FILTERS,
};

const DISK: Record<string, KeyDef> = {
  filesystem: { description: "One of ext4, xfs, zfs or btrfs (btrfs is Proxmox VE only). zfs.*, lvm.* and btrfs.* options apply to the matching filesystem.", options: ["ext4", "xfs", "zfs", "btrfs"] },
  "disk-list": {
    description: 'List of disks to use. Useful if you are sure about the disk names. For example: disk-list = ["sda", "sdb"].',
    type: "list",
  },
  ...DISK_FILTERS,
  "filter-match": {
    description:
      'Can be "any" or "all". Decides if a match of any filter is enough of if all filters need to match for a disk to be selected. Default is "any".',
    options: ["any", "all"],
  },
  "zfs.raid": {
    description: "The RAID level that should be used. Options are raid0, raid1, raid10, raidz-1, raidz-2, or raidz-3.",
    options: ["raid0", "raid1", "raid10", "raidz-1", "raidz-2", "raidz-3"],
  },
  "zfs.ashift": {
    description:
      "Defines the ashift value for the created pool. The ashift needs to be set at least to the sector-size of the underlying disks (2 to the power of ashift is the sector-size), or any disk which might be put in the pool (for example the replacement of a defective disk).",
    type: "int",
  },
  "zfs.arc-max": {
    description:
      "Maximum size of the ZFS ARC in MiB, which limits how much memory ZFS will use. See 'Limit ZFS Memory Usage' in the PVE admin guide.",
    type: "int",
  },
  "zfs.checksum": {
    description: "Optional. The checksumming algorithm for rpool: on (default), fletcher4 or sha256.",
    options: ["on", "fletcher4", "sha256"],
  },
  "zfs.compress": {
    description: "Optional. Whether compression is enabled for rpool and which algorithm: on (default), off, lzjb, lz4, zle, gzip or zstd.",
    options: ["on", "off", "lzjb", "lz4", "zle", "gzip", "zstd"],
  },
  "zfs.copies": {
    description:
      "Defines the copies parameter for rpool. Check the zfs(8) manpage for the semantics, and why this does not replace redundancy on disk-level.",
    type: "int",
  },
  "zfs.hdsize": {
    description:
      "Total disk size to use, in GiB (decimals allowed). Leaves free space for further partitioning, e.g. a swap partition. Only honored for bootable disks: the first disk or mirror for RAID0, RAID1 or RAID10, and all disks in RAID-Z[123].",
    type: "int",
  },
  "lvm.hdsize": {
    description:
      "Total disk size to use, in GiB (decimals allowed). Reserves free space for further partitioning, e.g. an additional PV and VG for LVM storage.",
    type: "int",
  },
  "lvm.swapsize": {
    description:
      "Size of the swap volume in GiB. Defaults to the installed memory, clamped to 4–8 GiB, and cannot exceed hdsize/8.",
    type: "int",
  },
  "lvm.maxroot": {
    description: "Maximum size of the root volume in GiB. Limited to hdsize/4 (half the remaining space below 48 GiB free, unlimited below 12 GiB).",
    type: "int",
  },
  "lvm.maxvz": {
    description:
      "Maximum size of the data volume in GiB. The data volume is hdsize - rootsize - swapsize - minfree, capped at maxvz.",
    type: "int",
  },
  "lvm.minfree": {
    description:
      "Free space to leave in the pve volume group, in GiB. Defaults to 16 GiB with more than 128 GiB of storage, otherwise hdsize/8.",
    type: "int",
  },
  "btrfs.raid": { description: "The RAID level that should be used. Options are raid0, raid1, and raid10", options: ["raid0", "raid1", "raid10"] },
  "btrfs.hdsize": { description: "Total disk size to use, in GiB (decimals allowed).", type: "int" },
  "btrfs.compress": {
    description: "The compression type to use. Possible options are on, off, zlib, lzo and zstd. Defaults to off. See also the btrfs(5) manpage.",
    options: ["on", "off", "zlib", "lzo", "zstd"],
  },
};

const POST_INSTALL: Record<string, KeyDef> = {
  url: {
    description:
      "The URL the information about the installed system should be sent to as HTTP POST request. Point this at this Worker's /hook/<relay> endpoint to fan the payload out to your automation.",
    format: "url",
  },
  "cert-fingerprint": { description: "Optional. SHA256 certificate fingerprint if certificate pinning should be used.", format: "fingerprint" },
  "auth-token": {
    description:
      "Optional (PVE 9.2+). An opaque token the installer adds as a top-level \"token\" field in the webhook's JSON body, so the receiver can authenticate the callback. Treated as a credential.",
    type: "str",
    secret: true,
  },
};

const FIRST_BOOT: Record<string, KeyDef> = {
  source: {
    description: "Where to source the executable for running at first boot from. It can either be from-iso or from-url.",
    options: ["from-iso", "from-url"],
  },
  ordering: {
    description: "Optional. At what stage of the boot to run the hook. It can be one of before-network, network-online or fully-up.",
    options: ["before-network", "network-online", "fully-up"],
  },
  url: { description: 'Required when source = "from-url". The URL of the executable file to download.', format: "url" },
  "cert-fingerprint": {
    description: "Optional. SHA256 certificate fingerprint if certificate pinning should be used for the download of the executable file.",
    format: "fingerprint",
  },
};

export const SECTIONS: SectionDef[] = [
  { id: "global", label: "Global", keys: GLOBAL },
  { id: "network", label: "Network", keys: NETWORK },
  {
    id: "network.interface-name-pinning.mapping",
    label: "NIC Pinning",
    keys: {},
    freeform: true,
    help: "Pin NIC names (PVE 9.1+). With pinning enabled and no mapping, the installer names every NIC nic0, nic1, …; map a MAC address here to choose a name yourself. A mapping implies enabled = true.",
  },
  { id: "disk-setup", label: "Disk", keys: DISK },
  { id: "post-installation-webhook", label: "Post Install", keys: POST_INSTALL },
  { id: "first-boot", label: "First Boot", keys: FIRST_BOOT },
];

/** TOML emit order; also the sections the merge walks. */
export const SECTION_ORDER = [
  "global",
  "network",
  "network.interface-name-pinning",
  "network.interface-name-pinning.mapping",
  "disk-setup",
  "post-installation-webhook",
  "first-boot",
] as const;

/** Sections that are dropped from the response when empty (upstream behaviour). */
export const PRUNE_WHEN_EMPTY = [
  "global",
  "network",
  "first-boot",
  "network.interface-name-pinning.mapping",
  "post-installation-webhook",
  "disk-setup",
];

const SECTION_KEYS: Record<string, Record<string, KeyDef>> = {
  global: GLOBAL,
  network: NETWORK,
  "disk-setup": DISK,
  "post-installation-webhook": POST_INSTALL,
  "first-boot": FIRST_BOOT,
};

export function keyDef(section: string, key: string): KeyDef | undefined {
  return SECTION_KEYS[section]?.[key];
}

/** True when this section/key pair holds a credential. */
export function isSecretKey(section: string, key: string): boolean {
  if (keyDef(section, key)?.secret) return true;
  // Free-form keys the operator invented: anything that smells like a credential.
  return /(^|[-_.])(password|passwd|secret|token|api[-_]?key|private[-_]?key)([-_.]|$)/i.test(key);
}

export function isSensitiveKey(section: string, key: string): boolean {
  return isSecretKey(section, key) || !!keyDef(section, key)?.sensitive;
}

export const DEFAULT_ANSWER_DOC = {
  global: {
    keyboard: "en-us",
    country: "at",
    fqdn: "pveauto.testinstall",
    mailto: "mail@no.invalid",
    timezone: "Europe/Vienna",
  },
  network: { source: "from-dhcp" },
  "disk-setup": { filesystem: "zfs", "zfs.raid": "raid1", "disk-list": ["sda", "sdb"] },
  must_contain: [] as string[],
  must_not_contain: [] as string[],
};
