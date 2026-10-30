import { spawn, type ChildProcess } from "node:child_process";

/*
 * The worker's child processes: ffmpeg, ffprobe and heif-dec. Each runs from an argument list,
 * never a shell string, so nothing in a file's name or metadata can become a command. Each has a
 * time limit, and is killed when its job's signal aborts (the job expired, or pg-boss gave up on
 * it) or when the worker stops. Run ffmpeg and ffprobe with `-loglevel error`: their stderr is kept
 * for the job's error, and at the default level it lists the file's metadata, location included.
 */

/** How much of the end of a program's stderr a failure keeps. */
const STDERR_TAIL_CHARACTERS = 4000;
/** The most stdout a program may print (ffprobe's JSON is a few KB); more kills it. */
const STDOUT_LIMIT_BYTES = 4 * 1024 * 1024;

export type ProcessOptions = {
  /** The job's signal: aborting it kills the program. */
  signal: AbortSignal;
  /** Kills the program once it has run this long. */
  timeoutMilliseconds: number;
  /**
   * Required, so no call can forget it. `background` runs it under `nice -n 19`, so it takes only
   * the CPU photos leave: conversions and other long video work. `foreground` runs it at the
   * worker's own priority: a photo's tools (heif-dec), which must stay fast.
   */
  priority: "background" | "foreground";
  cwd?: string;
};

export type ProcessOutput = { stdout: string; stderrTail: string };

/** How a program ended: by itself, or killed for running too long, for its job, or for the worker stopping. */
export type ProcessEnding = "exit" | "timeout" | "aborted" | "stopping" | "too-much-output";

/** A program that failed, or was killed. Its message names the program and how it ended, never its arguments. */
export class ProcessError extends Error {
  override name = "ProcessError";
  constructor(
    readonly command: string,
    readonly ending: ProcessEnding,
    readonly exitCode: number | null,
    readonly stderrTail: string,
  ) {
    super(
      ending === "exit"
        ? `${command} exited with ${exitCode}: ${stderrTail.trim().split("\n").at(-1) ?? ""}`
        : `${command} was killed: ${ending}`,
    );
  }
}

// The programs running now, each with the function that kills it and records why.
const running = new Map<ChildProcess, (ending: ProcessEnding) => void>();
let stopping = false;

/**
 * Runs `command` with `args` and resolves with its stdout and the end of its stderr once it exits
 * with 0. Rejects with a ProcessError when it exits otherwise or is killed (SIGKILL: its output is
 * scratch, and the job retries or fails anyway), or with the spawn error when it can't start.
 */
export function runProcess(command: string, args: readonly string[], options: ProcessOptions): Promise<ProcessOutput> {
  if (stopping) return Promise.reject(new ProcessError(command, "stopping", null, ""));
  if (options.signal.aborted) return Promise.reject(new ProcessError(command, "aborted", null, ""));

  const [file, fileArgs] =
    options.priority === "background" ? ["nice", ["-n", "19", command, ...args]] : [command, [...args]];
  // `nice` replaces itself with the program, so the child's pid is the program's.
  const child = spawn(file, fileArgs, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], shell: false });

  return new Promise((resolve, reject) => {
    let killedFor: ProcessEnding | null = null;
    let settled = false;
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrTail = "";

    const kill = (ending: ProcessEnding) => {
      killedFor ??= ending;
      child.kill("SIGKILL");
    };
    const onAbort = () => kill("aborted");
    const timer = setTimeout(() => kill("timeout"), options.timeoutMilliseconds);
    options.signal.addEventListener("abort", onAbort, { once: true });
    running.set(child, kill);

    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      running.delete(child);
      outcome();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > STDOUT_LIMIT_BYTES) kill("too-much-output");
      else stdoutChunks.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARACTERS);
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (exitCode) =>
      finish(() => {
        if (exitCode === 0 && killedFor === null) {
          resolve({ stdout: Buffer.concat(stdoutChunks).toString("utf8"), stderrTail });
        } else {
          reject(new ProcessError(command, killedFor ?? "exit", exitCode, stderrTail));
        }
      }),
    );
  });
}

/** The process ids of the programs running now. */
export function runningProcessIds(): number[] {
  return [...running.keys()].flatMap((child) => (child.pid === undefined ? [] : [child.pid]));
}

/**
 * Kills every running program and refuses to start new ones: the worker is stopping. Their jobs
 * fail and go back to their queues for the next start.
 */
export function stopAllProcesses(): void {
  stopping = true;
  for (const kill of running.values()) kill("stopping");
}
