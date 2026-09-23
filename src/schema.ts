/**
 * Answer-file key catalogue, ported from autopve/tabs/settings.py.
 *
 * Every key the Proxmox automated installer understands is described here once
 * and reused by the API (validation, secret classification) and by the UI
 * (pulldowns, help text). Keys not in the catalogue are still allowed — the
 * upstream app lets you type a unique key and so does this one.
 */

export type KeyType = "str" | "int" | "bool" | "list";

export interface KeyDef {
  description: string;
  options?: string[];
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
  },
  country: { description: "The country code in the two letter variant. For example, at, us or fr." },
  fqdn: { description: "The fully qualified domain name of the host. The domain part will be used as the search domain." },
  "fqdn.source": {
    description:
      "Must be set to 'from-dhcp'. Retrieves the host name (option 12) and, if available, domain name (option 15) from the DHCP lease configuration. In this mode, the DHCP server must provide a host name, otherwise the installation will fail.",
    options: ["from-dhcp"],
  },
  "fqdn.domain": { description: "Fallback (search) domain name to use if the DHCP server does not provide one." },
  mailto: { description: "The default email address for the user root." },
  timezone: { description: "The timezone in tzdata format. For example, Europe/Vienna or America/New_York." },
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
};

const NETWORK: Record<string, KeyDef> = {
  source: {
    description: "Where to source the static network configuration from. This can be from-dhcp or from-answer.",
    options: ["from-dhcp", "from-answer"],
  },
  cidr: { description: "The IP address in CIDR notation. For example, 192.168.1.10/24." },
  dns: { description: "The IP address of the DNS server." },
  gateway: { description: "The IP address of the default gateway." },
  "filter.ID_NET_NAME_MAC": { description: "Filter against the ID_NET_NAME_MAC property to select the network card. See filters." },
};

const DISK: Record<string, KeyDef> = {
  filesystem: { description: "One of the following options: ext4, xfs, zfs, or btrfs.", options: ["ext4", "xfs", "zfs", "btrfs"] },
  "disk-list": {
    description: 'List of disks to use. Useful if you are sure about the disk names. For example: disk-list = ["sda", "sdb"].',
    type: "list",
  },
  filter: { description: "Filter against UDEV properties to select the disks for the installation. See filters." },
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
      "Defines the maximum size the ARC can grow to and thus limits the amount of memory ZFS will use. See also the section on how to limit ZFS memory usage for more details.",
    type: "int",
  },
  "zfs.checksum": { description: "Defines which checksumming algorithm should be used for rpool." },
  "zfs.compress": { description: "Defines whether compression is enabled for rpool." },
  "zfs.copies": {
    description:
      "Defines the copies parameter for rpool. Check the zfs(8) manpage for the semantics, and why this does not replace redundancy on disk-level.",
    type: "int",
  },
  "zfs.hdsize": {
    description:
      "Defines the total hard disk size to be used. This is useful to save free space on the hard disk(s) for further partitioning (for example to create a swap-partition). hdsize is only honored for bootable disks, that is only the first disk or mirror for RAID0, RAID1 or RAID10, and all disks in RAID-Z[123].",
    type: "int",
  },
  "lvm.hdsize": {
    description:
      "Defines the total hard disk size to be used. This way you can reserve free space on the hard disk for further partitioning (for example for an additional PV and VG on the same hard disk that can be used for LVM storage).",
    type: "int",
  },
  "lvm.swapsize": {
    description:
      "Defines the size of the swap volume. The default is the size of the installed memory, minimum 4 GB and maximum 8 GB. The resulting value cannot be greater than hdsize/8.",
    type: "int",
  },
  "lvm.maxroot": {
    description: "Defines the maximum size of the root volume, which stores the operation system. The maximum limit of the root volume size is hdsize/4.",
    type: "int",
  },
  "lvm.maxvz": {
    description:
      "Defines the maximum size of the data volume. The actual size of the data volume is: datasize = hdsize - rootsize - swapsize - minfree Where datasize cannot be bigger than maxvz.",
    type: "int",
  },
  "lvm.minfree": {
    description:
      "Defines the amount of free space that should be left in the LVM volume group pve. With more than 128GB storage available, the default is 16GB, otherwise hdsize/8 will be used.",
    type: "int",
  },
  "btrfs.raid": { description: "The RAID level that should be used. Options are raid0, raid1, and raid10", options: ["raid0", "raid1", "raid10"] },
  "btrfs.hdsize": { description: "Defines the total hard disk size to be used.", type: "int" },
  "btrfs.compress": {
    description: "The compression type to use. Possible options are on, off, zlib, lzo and zstd. Defaults to off. See also the btrfs(5) manpage.",
    options: ["on", "off", "zlib", "lzo", "zstd"],
  },
};

const POST_INSTALL: Record<string, KeyDef> = {
  url: {
    description:
      "The URL the information about the installed system should be sent to as HTTP POST request. Point this at this Worker's /hook/<relay> endpoint to fan the payload out to your automation.",
  },
  "cert-fingerprint": { description: "Optional. SHA256 certificate fingerprint if certificate pinning should be used." },
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
  url: { description: 'Required when source = "from-url". The URL of the executable file to download.' },
  "cert-fingerprint": {
    description: "Optional. SHA256 certificate fingerprint if certificate pinning should be used for the download of the executable file.",
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
    help: "Map a MAC address to the interface name it should be pinned to. Enabling this writes [network.interface-name-pinning] enabled = true.",
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
