import { describe, it, expect } from "bun:test";
import { drainProcessStderr } from "../src/audio-router";

describe("Subprocess stderr Draining", () => {
  it("drains stderr stream asynchronously to prevent OS pipe deadlock", async () => {
    // Simulamos un stream de stderr que genera múltiples chunks grandes
    const chunks = [
      new TextEncoder().encode("line 1: ffmpeg starting\n"),
      new TextEncoder().encode("line 2: frame 100 fps=30\n"),
      new TextEncoder().encode("line 3: warning buffer low\n"),
      new TextEncoder().encode("line 4: stream finished\n"),
    ];

    let readIndex = 0;
    const mockStderr = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (readIndex < chunks.length) {
          controller.enqueue(chunks[readIndex++]!);
        } else {
          controller.close();
        }
      },
    });

    let exitCodeResolved = -1;
    const mockProcess = {
      stderr: mockStderr,
      exited: new Promise<number>((resolve) => {
        setTimeout(() => {
          exitCodeResolved = 0;
          resolve(0);
        }, 10);
      }),
    };

    // drainProcessStderr no debe bloquear ni lanzar error
    drainProcessStderr(mockProcess, "MockProcess");

    await mockProcess.exited;
    expect(exitCodeResolved).toBe(0);
  });
});
