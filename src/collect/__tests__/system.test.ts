import { describe, it, expect } from "vitest";
import { pickPrimaryIp, readOsReleaseField } from "../system.js";

describe("readOsReleaseField", () => {
  it("parses unquoted Ubuntu values", () => {
    const s = 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID="24.04"';
    expect(readOsReleaseField(s, "ID")).toBe("ubuntu");
    expect(readOsReleaseField(s, "ID_LIKE")).toBe("debian");
    expect(readOsReleaseField(s, "VERSION_ID")).toBe("24.04");
  });

  it("parses quoted RHEL-family values", () => {
    const s = 'NAME="Rocky Linux"\nID="rocky"\nID_LIKE="rhel centos fedora"\nVERSION_ID="9.6"';
    expect(readOsReleaseField(s, "ID")).toBe("rocky");
    expect(readOsReleaseField(s, "ID_LIKE")).toBe("rhel centos fedora");
    expect(readOsReleaseField(s, "VERSION_ID")).toBe("9.6");
  });

  it("parses Debian's bare numeric VERSION_ID", () => {
    // Debian trixie /etc/os-release: VERSION_ID="13" (with quotes).
    // Earlier Debian releases sometimes wrote VERSION_ID=13 unquoted;
    // both shapes must parse to the same value.
    expect(readOsReleaseField('VERSION_ID="13"', "VERSION_ID")).toBe("13");
    expect(readOsReleaseField("VERSION_ID=13", "VERSION_ID")).toBe("13");
  });

  it("lowercases the result (some distros uppercase their ID)", () => {
    expect(readOsReleaseField("ID=Alpine", "ID")).toBe("alpine");
  });

  it("returns undefined for a missing key", () => {
    expect(readOsReleaseField("ID=arch", "ID_LIKE")).toBeUndefined();
  });

  it("does not confuse ID with VERSION_ID", () => {
    const s = 'VERSION_ID="24.04"\nID=ubuntu';
    expect(readOsReleaseField(s, "ID")).toBe("ubuntu");
  });
});

describe("pickPrimaryIp", () => {
  it("skips a leading APIPA address (Supermicro BMC usb0 enumerates first)", () => {
    // Observed on glassmkr-val-centos: usb0 carries 169.254.3.1 ahead of
    // the real uplink, so first-token selection showed the BMC plumbing
    // as the server IP in notifications.
    expect(pickPrimaryIp("169.254.3.1 152.233.13.153")).toBe("152.233.13.153");
  });

  it("keeps the first address when it is already global scope", () => {
    expect(pickPrimaryIp("152.233.13.153 169.254.3.1")).toBe("152.233.13.153");
    expect(pickPrimaryIp("10.0.0.5")).toBe("10.0.0.5");
  });

  it("skips loopback and IPv6 link-local", () => {
    expect(pickPrimaryIp("127.0.0.1 fe80::1 192.0.2.10")).toBe("192.0.2.10");
  });

  it("prefers a global IPv6 over a link-local IPv4", () => {
    expect(pickPrimaryIp("169.254.3.1 2001:db8::1")).toBe("2001:db8::1");
  });

  it("falls back to the first address when nothing global exists", () => {
    expect(pickPrimaryIp("169.254.3.1 127.0.0.1")).toBe("169.254.3.1");
  });

  it("returns unknown for empty output", () => {
    expect(pickPrimaryIp("")).toBe("unknown");
    expect(pickPrimaryIp("   ")).toBe("unknown");
  });
});
