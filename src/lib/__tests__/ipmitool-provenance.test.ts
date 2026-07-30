import { describe, it, expect } from "vitest";
import {
  resolveIpmitoolPath,
  attributeIpmitool,
  parseDpkgOwner,
  SECURE_PATH_DIRS,
} from "../ipmitool-provenance.js";

/** Reject like execFile does when a command is missing or a query finds no owner. */
function rejects(msg = "not found"): () => Promise<{ stdout: string }> {
  return () => Promise.reject(new Error(msg));
}

describe("resolveIpmitoolPath", () => {
  it("returns the FIRST match in sudo secure_path order, not the packaged one", () => {
    // The whole point of the gate: /usr/local/bin precedes /usr/bin, so a local
    // build shadows the distro package and is what root actually execs. Verified
    // live on Debian 13 (2026-07-30).
    const path = resolveIpmitoolPath({
      exists: (p) => p === "/usr/local/bin/ipmitool" || p === "/usr/bin/ipmitool",
    });
    expect(path).toBe("/usr/local/bin/ipmitool");
  });

  it("finds the packaged binary when nothing shadows it", () => {
    expect(resolveIpmitoolPath({ exists: (p) => p === "/usr/bin/ipmitool" }))
      .toBe("/usr/bin/ipmitool");
  });

  it("returns null when no candidate exists", () => {
    expect(resolveIpmitoolPath({ exists: () => false })).toBeNull();
  });

  it("treats an unreadable directory as absent rather than throwing", () => {
    const path = resolveIpmitoolPath({
      exists: (p) => {
        if (p.startsWith("/usr/local")) throw new Error("EACCES");
        return p === "/usr/bin/ipmitool";
      },
    });
    expect(path).toBe("/usr/bin/ipmitool");
  });

  it("searches exactly the sudo default secure_path, in order", () => {
    expect([...SECURE_PATH_DIRS]).toEqual([
      "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin",
    ]);
  });
});

describe("attributeIpmitool", () => {
  it("attributes a dpkg-owned binary and reports the EVR that ipmitool -V hides", async () => {
    const p = await attributeIpmitool({
      exists: (x) => x === "/usr/bin/ipmitool",
      run: async (cmd, args) => {
        if (cmd === "dpkg-query" && args[0] === "-S") return { stdout: "ipmitool: /usr/bin/ipmitool\n" };
        if (cmd === "dpkg-query" && args[0] === "-W") return { stdout: "1.8.18-11ubuntu2.2" };
        throw new Error("unexpected");
      },
    });
    expect(p.attributed).toBe(true);
    expect(p.package).toBe("ipmitool 1.8.18-11ubuntu2.2");
    expect(p.path).toBe("/usr/bin/ipmitool");
  });

  it("still attributes when the package is owned but its version is unreadable", async () => {
    const p = await attributeIpmitool({
      exists: (x) => x === "/usr/bin/ipmitool",
      run: async (cmd, args) => {
        if (cmd === "dpkg-query" && args[0] === "-S") return { stdout: "ipmitool: /usr/bin/ipmitool\n" };
        throw new Error("dpkg-query -W blew up");
      },
    });
    expect(p.attributed).toBe(true);
    expect(p.package).toBe("ipmitool");
  });

  it("attributes an rpm-owned binary when dpkg is absent", async () => {
    const p = await attributeIpmitool({
      exists: (x) => x === "/usr/bin/ipmitool",
      run: async (cmd) => {
        if (cmd === "dpkg-query") throw new Error("ENOENT");
        if (cmd === "rpm") return { stdout: "ipmitool 1.8.18-27.el9\n" };
        throw new Error("unexpected");
      },
    });
    expect(p.attributed).toBe(true);
    expect(p.package).toBe("ipmitool 1.8.18-27.el9");
  });

  it("does NOT attribute a source build in /usr/local/bin (the shadowing case)", async () => {
    // Reproduces what was proven on a real host: dpkg-query disowns the shadow.
    const p = await attributeIpmitool({
      exists: (x) => x === "/usr/local/bin/ipmitool" || x === "/usr/bin/ipmitool",
      run: rejects("no path found matching pattern /usr/local/bin/ipmitool"),
    });
    expect(p.attributed).toBe(false);
    expect(p.package).toBeNull();
    expect(p.path).toBe("/usr/local/bin/ipmitool");
    expect(p.detail).toMatch(/not owned by any dpkg or rpm package/);
  });

  it("does not attribute when rpm answers 'not owned by any package' on stdout", async () => {
    // Some rpm builds print that phrase and exit 0 rather than rejecting.
    const p = await attributeIpmitool({
      exists: (x) => x === "/usr/local/bin/ipmitool",
      run: async (cmd) => {
        if (cmd === "dpkg-query") throw new Error("ENOENT");
        return { stdout: "file /usr/local/bin/ipmitool is not owned by any package\n" };
      },
    });
    expect(p.attributed).toBe(false);
  });

  it("does not attribute when neither package manager exists", async () => {
    const p = await attributeIpmitool({
      exists: (x) => x === "/usr/bin/ipmitool",
      run: rejects("ENOENT"),
    });
    expect(p.attributed).toBe(false);
  });

  it("does not attribute when no binary is found at all", async () => {
    const p = await attributeIpmitool({ exists: () => false, run: rejects() });
    expect(p.attributed).toBe(false);
    expect(p.path).toBeNull();
    expect(p.detail).toMatch(/no ipmitool found in/);
  });

  it("never returns attributed on an empty dpkg answer", async () => {
    // A blank stdout must not parse into a truthy package name.
    const p = await attributeIpmitool({
      exists: (x) => x === "/usr/bin/ipmitool",
      run: async (cmd) => {
        if (cmd === "dpkg-query") return { stdout: "\n" };
        throw new Error("ENOENT");
      },
    });
    expect(p.attributed).toBe(false);
  });
});

describe("dpkg output parsing (adversarial review 2026-07-30, finding #3)", () => {
  it("does NOT attribute when a dpkg DIVERSION applies to the path", async () => {
    // A diversion is how an unpatched binary is placed AT the packaged path while the
    // real packaged file is moved aside, so this is the attack the gate exists to stop.
    // The naive parse read "local diversion from" as the package name.
    const p = await attributeIpmitool({
      exists: (x) => x === "/usr/bin/ipmitool",
      run: async (cmd, args) => {
        if (cmd === "dpkg-query" && args[0] === "-S") {
          return { stdout: "local diversion from: /usr/bin/ipmitool\nlocal diversion to: /usr/bin/ipmitool.distrib\n" };
        }
        throw new Error("unexpected");
      },
    });
    expect(p.attributed).toBe(false);
    expect(p.package).toBeNull();
    expect(p.detail).toMatch(/diversion/i);
  });

  it("still attributes correctly when a diversion line concerns ANOTHER package", async () => {
    // dpkg emits diversion diagnostics about other files too; those must not
    // disqualify an otherwise clean ownership answer for our path.
    expect(parseDpkgOwner("diversion by other-pkg from: /usr/bin/somethingelse\nipmitool: /usr/bin/ipmitool\n", "/usr/bin/ipmitool"))
      .toBe("ipmitool");
  });

  it("rejects a diagnostic line as a package name", () => {
    expect(parseDpkgOwner("local diversion from: /usr/bin/ipmitool\n", "/usr/bin/ipmitool")).toBeNull();
  });

  it("ignores an ownership answer about a DIFFERENT path", () => {
    expect(parseDpkgOwner("otherpkg: /usr/bin/other\n", "/usr/bin/ipmitool")).toBeNull();
  });

  it("takes the first package when several ship the same path", () => {
    expect(parseDpkgOwner("pkg-a, pkg-b: /usr/bin/ipmitool\n", "/usr/bin/ipmitool")).toBe("pkg-a");
  });
});
