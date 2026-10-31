import { describe, expect, it, vi } from "vitest";
import { ProcessError, runningProcessIds, runProcess } from "./processes";

const NEVER = new AbortController().signal;
const MINUTE = 60_000;

function isRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runProcess", () => {
  it("runs a program with its arguments as they are, never through a shell", async () => {
    const { stdout } = await runProcess("printf", ["%s|", "a b", "$(echo injected)", "; rm -rf /"], {
      signal: NEVER,
      priority: "foreground",
      timeoutMilliseconds: MINUTE,
    });
    expect(stdout).toBe("a b|$(echo injected)|; rm -rf /|");
  });

  it("runs background work under nice 19, so photos keep the CPU, and other work at the worker's own", async () => {
    const background = await runProcess("nice", [], { signal: NEVER, timeoutMilliseconds: MINUTE, priority: "background" });
    const foreground = await runProcess("nice", [], { signal: NEVER, priority: "foreground", timeoutMilliseconds: MINUTE });
    expect(background.stdout.trim()).toBe("19");
    expect(Number(foreground.stdout.trim())).toBeLessThan(19);
  });

  it("fails with the exit code and the end of what the program wrote to stderr", async () => {
    const failure = await runProcess(
      "sh",
      ["-c", 'for line in $(seq 0 1999); do echo "line $line" >&2; done; exit 3'],
      { signal: NEVER, priority: "foreground", timeoutMilliseconds: MINUTE },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProcessError);
    const { exitCode, stderrTail, ending } = failure as ProcessError;
    expect(exitCode).toBe(3);
    expect(ending).toBe("exit");
    expect(stderrTail).toContain("line 1999");
    expect(stderrTail).not.toContain("line 0\n");
    expect(stderrTail.length).toBeLessThanOrEqual(4000);
  });

  it("records the signal that ended a program something else killed, such as the kernel's OOM killer", async () => {
    const failure = await runProcess("sh", ["-c", "kill -KILL $$"], {
      signal: NEVER,
      priority: "foreground",
      timeoutMilliseconds: MINUTE,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProcessError);
    const { exitCode, ending, exitSignal, message } = failure as ProcessError;
    expect({ exitCode, ending, exitSignal }).toEqual({ exitCode: null, ending: "exit", exitSignal: "SIGKILL" });
    expect(message).toMatch(/sh died on SIGKILL/);
  });

  it("kills a program that runs past its time", async () => {
    const started = Date.now();
    const failure = await runProcess("sleep", ["30"], { signal: NEVER, priority: "foreground", timeoutMilliseconds: 200 }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProcessError);
    expect((failure as ProcessError).ending).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("kills a program when its job's signal is aborted", async () => {
    const job = new AbortController();
    const running = runProcess("sleep", ["30"], { signal: job.signal, priority: "foreground", timeoutMilliseconds: MINUTE });
    const [processId] = runningProcessIds();
    expect(isRunning(processId)).toBe(true);
    job.abort(new Error("the job expired"));
    const failure = await running.catch((error: unknown) => error);
    expect((failure as ProcessError).ending).toBe("aborted");
    expect(isRunning(processId)).toBe(false);
    expect(runningProcessIds()).toEqual([]);
  });

  it("refuses to start for a job whose signal is already aborted", async () => {
    const job = new AbortController();
    job.abort();
    await expect(runProcess("true", [], { signal: job.signal, priority: "foreground", timeoutMilliseconds: MINUTE })).rejects.toThrow();
    expect(runningProcessIds()).toEqual([]);
  });

  it("fails plainly when the program doesn't exist", async () => {
    await expect(
      runProcess("nona-no-such-program", [], { signal: NEVER, priority: "foreground", timeoutMilliseconds: MINUTE }),
    ).rejects.toThrow(/nona-no-such-program/);
    expect(runningProcessIds()).toEqual([]);
  });
});

describe("stopAllProcesses", () => {
  it("kills every running program at once, and refuses new ones: the worker is stopping", async () => {
    // A fresh copy of the module, so stopping it leaves the other tests' copy running.
    vi.resetModules();
    const processes = await import("./processes");
    const running = [
      processes.runProcess("sleep", ["30"], { signal: NEVER, timeoutMilliseconds: MINUTE, priority: "background" }),
      processes.runProcess("sleep", ["30"], { signal: NEVER, priority: "foreground", timeoutMilliseconds: MINUTE }),
    ];
    const processIds = processes.runningProcessIds();
    expect(processIds).toHaveLength(2);

    const started = Date.now();
    processes.stopAllProcesses();
    const failures = await Promise.all(running.map((finished) => finished.catch((error: unknown) => error)));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(failures.map((failure) => (failure as ProcessError).ending)).toEqual(["stopping", "stopping"]);
    expect(processIds.filter(isRunning)).toEqual([]);
    await expect(
      processes.runProcess("true", [], { signal: NEVER, priority: "foreground", timeoutMilliseconds: MINUTE }),
    ).rejects.toThrow(/stopping/);
  });
});
