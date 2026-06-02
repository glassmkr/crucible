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
export function classifyVendor(rawVendor: string | null, productName: string | null): { vendor: Vendor; is_virtual: boolean } {
  if (!rawVendor) return { vendor: "generic", is_virtual: false };
  const v = rawVendor.toLowerCase();
  const p = (productName ?? "").toLowerCase();

  if (v.includes("dell")) return { vendor: "dell", is_virtual: false };
  if (v.includes("hpe") || v.includes("hewlett packard enterprise")) return { vendor: "hpe", is_virtual: false };
  // Hewlett-Packard Company / Hewlett-Packard / Hewlett Packard (legacy
  // ProLiant DL3xx Gen8 era and earlier). Match before the standalone
  // "HP" rule so the rule below doesn't ambiguously catch HP-UX style
  // strings.
  if (/hewlett[\s-]?packard/i.test(rawVendor)) return { vendor: "hpe", is_virtual: false };
  // Standalone "HP" as a whole token. Tightened so non-vendor strings
  // like "HP-UX" (an OS name occasionally seen in product_name in
  // misconfigured firmwares) don't match. The character after "HP"
  // must be whitespace or end-of-string; product names start with a
  // space (e.g. "HP ProLiant ...").
  if (/(^|\s)hp(\s|$)/i.test(rawVendor)) return { vendor: "hpe", is_virtual: false };
  if (v.includes("supermicro")) return { vendor: "supermicro", is_virtual: false };
  if (v.includes("asrockrack") || v.includes("asrock rack")) return { vendor: "asrockrack", is_virtual: false };
  if (v.includes("lenovo")) return { vendor: "lenovo", is_virtual: false };
  if (v.includes("inspur")) return { vendor: "inspur", is_virtual: false };
  if (v.includes("cisco")) return { vendor: "cisco", is_virtual: false };

  // Virtualization signatures
  if (v.includes("qemu") || v.includes("kvm")) return { vendor: "virtual", is_virtual: true };
  if (v.includes("vmware")) return { vendor: "virtual", is_virtual: true };
  if (v.includes("innotek")) return { vendor: "virtual", is_virtual: true }; // VirtualBox
  if (v.includes("xen")) return { vendor: "virtual", is_virtual: true };
  // Hyper-V advertises sys_vendor=Microsoft Corporation, but so does a real
  // Surface laptop. Only classify as virtual when product_name says so.
  if (v.includes("microsoft") && p.includes("virtual machine")) {
    return { vendor: "virtual", is_virtual: true };
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

  const { vendor, is_virtual } = classifyVendor(rawVendor, productName);

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
