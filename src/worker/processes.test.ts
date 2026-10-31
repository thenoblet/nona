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

  it("keeps no link a program printed, the presigned link it was given least of all, nor its host", async () => {
    const link = "https://account-id.r2.example.com/nona-private/originals/x.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=key%2F20261205&x-amz-signature=0123abcd";
    const printed = [
      "[tcp @ 0x56] Connection to tcp://account-id.r2.example.com:443 failed: Connection refused",
      "[tcp @ 0x56] Failed to resolve hostname account-id.r2.example.com: Temporary failure in name resolution",
      `${link}: Invalid data found when processing input`,
      "Error opening input file https://elsewhere.example.com/a.mp4?X-AMZ-SIGNATURE=feed",
    ].join("\n");
    const failure = await runProcess("sh", ["-c", 'printf "%s\n" "$1" >&2; exit 1', "sh", printed, link], {
      signal: NEVER,
      priority: "foreground",
      timeoutMilliseconds: MINUTE,
      redact: { link, as: "the original" },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProcessError);
    const { stderrTail, message } = failure as ProcessError;
    for (const kept of [stderrTail, message]) {
      expect(kept).not.toMatch(/x-amz-|signature|credential|https?:\/\/|account-id/i);
    }
    expect(stderrTail).toContain("the original: Invalid data found when processing input");
    expect(stderrTail).toContain("the storage host");
    expect(message).toBe("sh exited with 1: Error opening input file a link");
  });

  it("drops the first line of a stderr tail that lost its beginning, which may be part of a link", async () => {
    const failure = await runProcess(
      "sh",
      ["-c", 'printf "%05000d" 0 >&2; printf "?X-Amz-Signature=cut%04000d\nlast line\n" 0 >&2; exit 1'],
      { signal: NEVER, priority: "foreground", timeoutMilliseconds: MINUTE },
    ).catch((error: unknown) => error);
    expect((failure as ProcessError).stderrTail).toBe("last line\n");
  });

  it("passes on a spawn error without the arguments Node attaches to it", async () => {
    const failure = await runProcess("nona-no-such-program", ["https://r2.example.com/x?X-Amz-Signature=secret"], {
      signal: NEVER,
      priority: "foreground",
      timeoutMilliseconds: MINUTE,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(failure)).not.toContain("secret");
    expect(Object.keys(failure as object)).not.toContain("spawnargs");
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
