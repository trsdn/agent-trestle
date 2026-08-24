import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createLiveChildSupervisor } from "../../src/process/live-child-supervisor.mjs";

class FakeProcess extends EventEmitter {
  constructor(pid = 9_000) {
    super();
    this.pid = pid;
    this.kills = [];
  }

  kill(pid, signal) {
    this.kills.push([pid, signal]);
    return true;
  }
}

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    return true;
  };
  return child;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for supervisor settlement");
    await sleep(5);
  }
}

test("supervisor installs one handler per signal only while live children exist", () => {
  const processImpl = new FakeProcess();
  const supervisor = createLiveChildSupervisor({ processImpl });
  const first = fakeChild(101);
  const second = fakeChild(102);

  const firstRegistration = supervisor.register(first, { detached: true });
  const secondRegistration = supervisor.register(second, { detached: true });
  assert.equal(processImpl.listenerCount("SIGINT"), 1);
  assert.equal(processImpl.listenerCount("SIGTERM"), 1);
  assert.equal(processImpl.listenerCount("SIGHUP"), 1);
  assert.equal(supervisor.activeCount(), 2);

  first.emit("close", 0, null);
  assert.equal(supervisor.activeCount(), 1);
  assert.equal(processImpl.listenerCount("SIGINT"), 1);

  firstRegistration.unregister();
  secondRegistration.unregister();
  assert.equal(supervisor.activeCount(), 0);
  assert.equal(processImpl.listenerCount("SIGINT"), 0);
  assert.equal(processImpl.listenerCount("SIGTERM"), 0);
  assert.equal(processImpl.listenerCount("SIGHUP"), 0);
});

test("supervisor terminates multiple detached groups before re-raising the parent signal", async () => {
  const processImpl = new FakeProcess();
  const reRaised = [];
  const supervisor = createLiveChildSupervisor({
    processImpl,
    terminationGraceMs: 5,
    forcedKillSettlementMs: 5,
    reRaise: (signal) => reRaised.push(signal),
  });
  supervisor.register(fakeChild(201), { detached: true });
  supervisor.register(fakeChild(202), { detached: true });

  processImpl.emit("SIGINT");
  assert.deepEqual(processImpl.kills, [
    [-201, "SIGTERM"],
    [-202, "SIGTERM"],
  ]);
  await waitFor(() => reRaised.length === 1);
  assert.deepEqual(processImpl.kills, [
    [-201, "SIGTERM"],
    [-202, "SIGTERM"],
    [-201, "SIGKILL"],
    [-202, "SIGKILL"],
  ]);
  assert.deepEqual(reRaised, ["SIGINT"]);
  assert.equal(processImpl.listenerCount("SIGINT"), 0);
});

test("supervisor falls back to direct children without process-group support", async () => {
  const processImpl = new FakeProcess();
  const child = fakeChild(301);
  const reRaised = [];
  const supervisor = createLiveChildSupervisor({
    processImpl,
    supportsProcessGroupKill: false,
    terminationGraceMs: 5,
    forcedKillSettlementMs: 5,
    reRaise: (signal) => reRaised.push(signal),
  });
  supervisor.register(child, { detached: false });

  processImpl.emit("SIGTERM");
  // Waits for the escalation itself rather than for a fixed duration: the
  // grace and settlement timers are 5 ms each, but a loaded runner fires them
  // late, and a fixed sleep then asserts against an unfinished sequence.
  await waitFor(() => child.kills.length === 2 && reRaised.length === 1);
  assert.deepEqual(processImpl.kills, []);
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(reRaised, ["SIGTERM"]);
});

test("supervisor never signals the caller's own process group", async () => {
  const processImpl = new FakeProcess(401);
  const child = fakeChild(401);
  const supervisor = createLiveChildSupervisor({
    processImpl,
    terminationGraceMs: 5,
    forcedKillSettlementMs: 5,
    reRaise: () => {},
  });
  supervisor.register(child, { detached: true });

  processImpl.emit("SIGHUP");
  await waitFor(() => child.kills.length === 2);
  assert.deepEqual(processImpl.kills, []);
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
});

test("supervisor leaves an existing library-consumer signal policy in control", async () => {
  const processImpl = new FakeProcess();
  let externalSignals = 0;
  const externalHandler = () => {
    externalSignals += 1;
  };
  processImpl.on("SIGTERM", externalHandler);
  const reRaised = [];
  const supervisor = createLiveChildSupervisor({
    processImpl,
    terminationGraceMs: 5,
    forcedKillSettlementMs: 5,
    reRaise: (signal) => reRaised.push(signal),
  });
  const registration = supervisor.register(fakeChild(501), { detached: true });

  processImpl.emit("SIGTERM");
  // The escalation is observable through the recorded kills; waiting on it
  // instead of on a duration keeps the assertions below on the far side of the
  // sequence even when a loaded runner fires the grace timer late.
  await waitFor(() => processImpl.kills.length === 2);
  assert.equal(externalSignals, 1);
  assert.deepEqual(reRaised, []);
  assert.equal(processImpl.listenerCount("SIGTERM"), 2);

  registration.unregister();
  // Settlement may still be pending here, and it is settlement that uninstalls
  // the supervisor's handler, so converge on the end state rather than
  // assuming it has already been reached.
  await waitFor(() => processImpl.listenerCount("SIGTERM") === 1);
  processImpl.removeListener("SIGTERM", externalHandler);
});
