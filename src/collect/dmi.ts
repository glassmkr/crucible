import { join } from "node:path";
import { readFileTrim } from "../lib/parse.js";
import type { DmiInfo, Vendor } from "../lib/types.js";

const DMI_ROOT = "/sys/class/dmi/id";

/**
 * Classify the contents of /sys/class/dmi/id/sys_vendor (and product_name
 * for the Microsoft Hyper-V edge case) into a canonical vendor.
 *
 * Match is case-insensitive substring on sys_vendor unless noted.
 */
// Firmware placeholder manufacturer strings: consumer/OEM boards that never
// had a real system-manufacturer flashed. On these, sys_vendor is useless but
// baseboard-manufacturer usually carries the real vendor (val campaign,
// asrock: sys_vendor="To Be Filled By O.E.M.", baseboard="ASRockRack").
const PLACEHOLDER_VENDOR_RE = /^(to be filled by o\.?e\.?m\.?|default string|system manufacturer|o\.?e\.?m\.?|not specified|not applicable|none|unknown|\.)$/i;

export function isPlaceholderVendor(s: string | null): boolean {
  if (!s) return true;
  return PLACEHOLDER_VENDOR_RE.test(s.trim());
}

// Map a manufacturer string to a known hardware Vendor, or null if it matches
// no known vendor. Shared by the sys_vendor and board_vendor paths.
function knownVendorFrom(raw: string): Vendor | null {
  const v = raw.toLowerCase();
  if (v.includes("dell")) return "dell";
  if (v.includes("hpe") || v.includes("hewlett packard enterprise")) return "hpe";
  // Hewlett-Packard Company / Hewlett-Packard / Hewlett Packard (legacy
  // ProLiant DL3xx Gen8 era and earlier). Match before the standalone "HP"
  // rule so it doesn't ambiguously catch HP-UX style strings.
  if (/hewlett[\s-]?packard/i.test(raw)) return "hpe";
  // Standalone "HP" as a whole token. Tightened so non-vendor strings like
  // "HP-UX" don't match; the char after "HP" must be whitespace or end.
  if (/(^|\s)hp(\s|$)/i.test(raw)) return "hpe";
  if (v.includes("supermicro")) return "supermicro";
  if (v.includes("asrockrack") || v.includes("asrock rack") || v.includes("asrock")) return "asrockrack";
  if (v.includes("lenovo")) return "lenovo";
  if (v.includes("inspur")) return "inspur";
  if (v.includes("cisco")) return "cisco";
  return null;
}

export function classifyVendor(
  rawVendor: string | null,
  productName: string | null,
  boardVendor: string | null = null,
): { vendor: Vendor; is_virtual: boolean } {
  const p = (productName ?? "").toLowerCase();

  if (rawVendor) {
    const v = rawVendor.toLowerCase();
    const known = knownVendorFrom(rawVendor);
    if (known) return { vendor: known, is_virtual: false };

    // Virtualization signatures (sys_vendor only; a baseboard vendor is never
    // a hypervisor).
    if (v.includes("qemu") || v.includes("kvm")) return { vendor: "virtual", is_virtual: true };
    if (v.includes("vmware")) return { vendor: "virtual", is_virtual: true };
    if (v.includes("innotek")) return { vendor: "virtual", is_virtual: true }; // VirtualBox
    if (v.includes("xen")) return { vendor: "virtual", is_virtual: true };
    // Hyper-V advertises sys_vendor=Microsoft Corporation, but so does a real
    // Surface laptop. Only classify as virtual when product_name says so.
    if (v.includes("microsoft") && p.includes("virtual machine")) {
      return { vendor: "virtual", is_virtual: true };
    }
  }

  // Fall back to the baseboard manufacturer when sys_vendor is a firmware
  // placeholder or simply unrecognized. This recovers the real vendor on
  // consumer/OEM boards (drives BMC-parser selection + vendor-keyed rules)
  // instead of silently collapsing to "generic".
  if (boardVendor && (isPlaceholderVendor(rawVendor) || knownVendorFrom(rawVendor ?? "") === null)) {
    const fromBoard = knownVendorFrom(boardVendor);
    if (fromBoard) return { vendor: fromBoard, is_virtual: false };
  }

  return { vendor: "generic", is_virtual: false };
}

export async function collectDmi(root: string = DMI_ROOT): Promise<DmiInfo> {
  // Empty-string contents are treated as absent (|| null), matching the
  // previous private readTrim's `raw.trim() || null`.
  const rawVendor = readFileTrim(join(root, "sys_vendor")) || null;
  const productName = readFileTrim(join(root, "product_name")) || null;
  const biosVersion = readFileTrim(join(root, "bios_version")) || null;
  const biosDate = readFileTrim(join(root, "bios_date")) || null;
  // Baseboard manufacturer: the classification fallback for OEM-placeholder
  // sys_vendor strings (world-readable, no privilege needed).
  const boardVendor = readFileTrim(join(root, "board_vendor")) || null;

  if (!rawVendor && !productName && !biosVersion && !biosDate) {
    return {
      available: false,
      vendor: "generic",
      raw_vendor: null,
      product_name: null,
      bios_version: null,
      bios_date: null,
      is_virtual: false,
    };
  }

  const { vendor, is_virtual } = classifyVendor(rawVendor, productName, boardVendor);

  return {
    available: true,
    vendor,
    raw_vendor: rawVendor,
    product_name: productName,
    bios_version: biosVersion,
    bios_date: biosDate,
    is_virtual,
  };
}

/**
 * One-line human-readable startup banner.
 *   "Vendor: Dell PowerEdge R740 (Dell Inc., BIOS 2.21.2, 2024-08-15)"
 *   "Vendor: virtual (KVM)"
 *   "Vendor: unknown (DMI not available)"
 */
export function formatVendorLine(info: DmiInfo): string {
  if (!info.available) return "Vendor: unknown (DMI not available)";
  if (info.is_virtual) return `Vendor: virtual (${info.raw_vendor ?? "unknown"})`;
  const parts: string[] = [];
  parts.push(info.product_name ?? "unknown product");
  const meta: string[] = [];
  if (info.raw_vendor) meta.push(info.raw_vendor);
  if (info.bios_version) meta.push(`BIOS ${info.bios_version}`);
  if (info.bios_date) meta.push(info.bios_date);
  return `Vendor: ${parts.join(" ")}${meta.length ? ` (${meta.join(", ")})` : ""}`;
}
