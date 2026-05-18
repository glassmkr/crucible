import { describe, it, expect } from "vitest";
import { readOsReleaseField } from "../system.js";

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
