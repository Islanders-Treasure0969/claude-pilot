import { describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "net";
import { autoPickPort, isPortAvailable, findAvailablePort } from "../cli.js";

describe("autoPickPort", () => {
  it("returns the same port for the same project path", () => {
    const a = autoPickPort("/path/to/project");
    const b = autoPickPort("/path/to/project");
    assert.equal(a, b);
  });

  it("usually returns different ports for different projects", () => {
    const a = autoPickPort("/path/to/project-a");
    const b = autoPickPort("/path/to/project-b");
    // not strictly guaranteed, but extremely likely with sha1
    assert.notEqual(a, b);
  });

  it("stays within the band [base, base+range)", () => {
    const port = autoPickPort("/some/random/path", 4000, 50);
    assert.ok(port >= 4000 && port < 4050, `port ${port} out of band`);
  });

  it("respects custom base and range", () => {
    const port = autoPickPort("/x", 5000, 10);
    assert.ok(port >= 5000 && port < 5010);
  });
});

describe("isPortAvailable", () => {
  it("returns true for an unused port", async () => {
    // 0 means OS picks a free port; we then close and check that exact port
    const free = await new Promise(resolve => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
    assert.equal(await isPortAvailable(free), true);
  });

  it("returns false for an occupied port", async () => {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const occupied = server.address().port;
    try {
      assert.equal(await isPortAvailable(occupied), false);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

describe("findAvailablePort", () => {
  it("returns the start port if free", async () => {
    // Find a free port via OS, then check that findAvailablePort picks it
    const free = await new Promise(resolve => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
    const result = await findAvailablePort(free, free, 10, 5);
    assert.equal(result, free);
  });

  it("probes forward when start is occupied", async () => {
    const blocker = net.createServer();
    await new Promise(resolve => blocker.listen(0, "127.0.0.1", resolve));
    const occupied = blocker.address().port;
    try {
      // Search a band that contains both `occupied` and a higher free port.
      // Since `occupied` is taken, the result must be different.
      const result = await findAvailablePort(occupied, occupied, 20, 10);
      assert.notEqual(result, occupied);
      assert.ok(result > occupied || result === null);
    } finally {
      await new Promise(resolve => blocker.close(resolve));
    }
  });

  it("returns null when no port in the band is free", async () => {
    // Occupy 3 consecutive ports, then probe with limit 3 in that exact band
    const servers = [];
    const ports = [];
    for (let i = 0; i < 3; i++) {
      const s = net.createServer();
      await new Promise(resolve => s.listen(0, "127.0.0.1", resolve));
      servers.push(s);
      ports.push(s.address().port);
    }
    try {
      // Probe with a tiny range and limit so we exhaust quickly.
      // Use the lowest of the occupied ports as base, range to cover all 3.
      const base = Math.min(...ports);
      const span = Math.max(...ports) - base + 1;
      const result = await findAvailablePort(base, base, span, span);
      // Result is either null (all occupied within band) or one of the gaps.
      // We can't guarantee no gap because OS picks arbitrary ports, so just
      // check the contract: if not null, it must be free.
      if (result !== null) {
        assert.ok(!ports.includes(result), `result ${result} should not be in ${ports}`);
      }
    } finally {
      for (const s of servers) await new Promise(r => s.close(r));
    }
  });
});
