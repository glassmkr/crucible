// Tests for cve.ts distro detection after the F7 refactor that routes
// /etc/os-release ID extraction through the shared system.ts
// readOsReleaseField (which lowercases + strips quotes). The
// CVE-specific family mapping stays in cve.ts; these lock that mapping.

import { describe, it, expect } from "vitest";
import { __test_only as cveTest } from "../cve.js";

const { distroFromOsRelease } = cveTest;

describe("cve distroFromOsRelease", () => {
  it("maps common os-release ID values to the CveDistro family", () => {
    expect(distroFromOsRelease('ID=ubuntu\nVERSION_ID="24.04"')).toBe("ubuntu");
    expect(distroFromOsRelease("ID=debian")).toBe("debian");
    expect(distroFromOsRelease('ID="rocky"')).toBe("rocky");
    expect(distroFromOsRelease("ID=almalinux")).toBe("alma");
    expect(distroFromOsRelease("ID=alma")).toBe("alma");
    expect(distroFromOsRelease("ID=rhel")).toBe("rhel");
    expect(distroFromOsRelease("ID=fedora")).toBe("fedora");
    expect(distroFromOsRelease("ID=centos")).toBe("centos");
    expect(distroFromOsRelease("ID=sles")).toBe("sles");
    expect(distroFromOsRelease('ID="opensuse-leap"')).toBe("opensuse");
  });

  it("lowercases the ID via the shared reader (quoted, capitalized)", () => {
    expect(distroFromOsRelease('ID="Ubuntu"')).toBe("ubuntu");
  });

  it("returns unknown for a missing or unrecognized ID", () => {
    expect(distroFromOsRelease('PRETTY_NAME="Something"')).toBe("unknown");
    expect(distroFromOsRelease("ID=plan9")).toBe("unknown");
  });
});
