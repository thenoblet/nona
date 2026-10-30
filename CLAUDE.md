# NONA'26

## Commits

Never add a signature to commits or pull requests: no `Co-Authored-By` trailers and no
"Generated with Claude Code" (or any other AI tool) lines. Commit messages end with their own text.

## Naming

Use descriptive names for variables, parameters, functions, classes, components and type
parameters. No single letters, including loop indexes, callback parameters and generics:
`celebration` not `c`, `index` not `i`, `event` not `e`, `TValue` not `T`. When you touch a
file that still has single-letter names, rename the ones in the code you change.

## External calls and slow work

Emails, third-party APIs and anything slow never block a request, the event loop or server startup:

- Send emails and call third-party services from background jobs (pg-boss), never in the request
  path; a request may only enqueue the job (in `after()` when it should not delay the response).
- Every network call has a timeout: database connect 5 s and statements 10 s, HTTP APIs 10 s.
- CPU-heavy work (image and video processing, zips) runs in the separate media worker, never in
  the web server.
- No synchronous file or network calls in request code.
- Server startup waits only for the bounded migrations; everything else (the job queue) starts in
  the background and retries on its own.
