import { runProcess, type ProcessError, type ProcessOutput } from "../processes";

/*
 * The programs the worker runs on a guest's file (heif-info and heif-dec for a HEIC, ffprobe and
 * ffmpeg for a video), each under a memory cap, and what their failures say about whose fault they
 * were. Each job decides the rest: what its tool printing nonsense, or running past its time, means.
 */

export type CappedRun = {
  /** The most address space the tool may take: prlimit --as. A crafted file hits it, a real one never does. */
  memoryBytes: number;
  /** The job's signal: aborting it kills the tool. */
  signal: AbortSignal;
  timeoutMilliseconds: number;
  cwd?: string;
};

/**
 * Runs `tool` under prlimit --as, at the worker's own priority: what a guest is waiting for (a
 * photo, a poster) never waits behind a conversion. prlimit replaces itself with the tool, so the
 * job's signal and the time limit kill the tool itself. Resolves with its stdout and the end of its
 * stderr; a failure is the ProcessError runProcess gives.
 */
export function runCapped(tool: string, args: readonly string[], run: CappedRun): Promise<ProcessOutput> {
  return runProcess("prlimit", [`--as=${run.memoryBytes}`, "--", tool, ...args], {
    signal: run.signal,
    timeoutMilliseconds: run.timeoutMilliseconds,
    priority: "foreground",
    cwd: run.cwd,
  });
}

// prlimit's own exit codes when it can't run the tool at all, and the loader's 127 when it can't map
// the tool's libraries: the worker's install (or a cap set far too low), not the file.
const TOOL_NOT_RUN = new Set([126, 127]);

/** Whether the tool never ran: prlimit or the loader couldn't start it. */
export function toolDidNotRun(error: ProcessError): boolean {
  return error.ending === "exit" && error.exitCode !== null && TOOL_NOT_RUN.has(error.exitCode);
}

/**
 * Whether something outside the worker killed the tool: a SIGKILL nothing in the worker sent, which
 * is the kernel's OOM killer when a conversion beside it filled the container. Under prlimit --as a
 * crafted file gets ENOMEM, never a SIGKILL.
 */
export function killedFromOutside(error: ProcessError): boolean {
  return error.ending === "exit" && error.exitSignal === "SIGKILL";
}

/** How the tool ended, in words for a failure's message. */
export function describeEnding(error: ProcessError): string {
  if (error.ending !== "exit") return `it was killed (${error.ending})`;
  return error.exitCode === null ? `it died on ${error.exitSignal ?? "a signal"}` : `it exited with ${error.exitCode}`;
}
