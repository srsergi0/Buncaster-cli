import { describe, expect, it } from "bun:test";
import { AudioRingBuffer } from "../src/ring-buffer";
import { preBuffer, preBufferOpus } from "../src/pre-buffer";
import { broadcast, broadcastOpus, evictClient } from "../src/broadcaster";
import { chunkWithIcy, buildMetadataBlock, createIcyState } from "../src/icy-metadata";
import { state, type RadioClient } from "../src/state";

describe("Phase 2 System Tests - End-to-End Verification", () => {
  it("verifies preBuffer and preBufferOpus are backed by AudioRingBuffer", () => {
    expect(preBuffer.ring).toBeInstanceOf(AudioRingBuffer);
    expect(preBufferOpus.ring).toBeInstanceOf(AudioRingBuffer);

    preBuffer.push(new Uint8Array([1, 2, 3, 4]));
    expect(preBuffer.bytes).toBeGreaterThanOrEqual(4);
    const snap = preBuffer.snapshot();
    expect(snap.length).toBeGreaterThanOrEqual(1);
  });

  it("verifies ICY cadence maintains exact intervals on empty title", () => {
    const icyState = createIcyState();
    icyState.metaInterval = 50;
    icyState.bytesSinceMeta = 0;

    // Send 60 bytes with empty title
    const chunk = new Uint8Array(60);
    const pieces = chunkWithIcy(chunk, icyState, "");

    // pieces: 50 bytes audio, 1 byte [0x00], 10 bytes audio
    expect(pieces.length).toBe(3);
    expect(pieces[0]!.length).toBe(50);
    expect(pieces[1]!.length).toBe(1);
    expect(pieces[1]![0]).toBe(0); // 0x00 empty metadata block
    expect(pieces[2]!.length).toBe(10);
    expect(icyState.bytesSinceMeta).toBe(10);
  });

  it("verifies metadata block caching", () => {
    const b1 = buildMetadataBlock("Song A");
    const b2 = buildMetadataBlock("Song A");
    expect(b1).toBe(b2);
    expect(b1[0]).toBeGreaterThan(0);

    const empty = buildMetadataBlock("");
    expect(empty.length).toBe(1);
    expect(empty[0]).toBe(0);
  });

  it("verifies tiered delivery and O(1) listener counts", () => {
    const mp3Id = "test-mp3-listener";
    const opusId = "test-opus-listener";

    let mp3Enqueued: Uint8Array[] = [];
    let opusEnqueued: Uint8Array[] = [];

    const mockMp3Controller: any = {
      enqueue(chunk: Uint8Array) { mp3Enqueued.push(chunk); },
      close() {},
      desiredSize: 10000,
    };

    const mockOpusController: any = {
      enqueue(chunk: Uint8Array) { opusEnqueued.push(chunk); },
      close() {},
      desiredSize: 10000,
    };

    const mp3Client: RadioClient = {
      id: mp3Id,
      controller: mockMp3Controller,
      connectedAt: new Date(),
      ip: "127.0.0.1",
      userAgent: "TestMP3",
      bytesSent: 0,
      slowStrikes: 0,
      tier: "mp3",
    };

    const opusClient: RadioClient = {
      id: opusId,
      controller: mockOpusController,
      connectedAt: new Date(),
      ip: "127.0.0.1",
      userAgent: "TestOpus",
      bytesSent: 0,
      slowStrikes: 0,
      tier: "opus",
    };

    state.clients.set(mp3Id, mp3Client);
    state.mp3Clients.set(mp3Id, mp3Client);
    state.listenersMp3 = state.mp3Clients.size;

    state.clients.set(opusId, opusClient);
    state.opusClients.set(opusId, opusClient);
    state.listenersOpus = state.opusClients.size;

    expect(state.listenersMp3).toBe(1);
    expect(state.listenersOpus).toBe(1);

    // Broadcast MP3
    broadcast(new Uint8Array([1, 2, 3, 4]));
    expect(mp3Enqueued.length).toBe(1);
    expect(opusEnqueued.length).toBe(0);

    // Broadcast Opus
    broadcastOpus(new Uint8Array([5, 6, 7]));
    expect(mp3Enqueued.length).toBe(1);
    expect(opusEnqueued.length).toBe(1);

    // Evict MP3 client
    evictClient(mp3Id, "test eviction");
    expect(state.clients.has(mp3Id)).toBe(false);
    expect(state.mp3Clients.has(mp3Id)).toBe(false);
    expect(state.listenersMp3).toBe(0);
    expect(state.listenersOpus).toBe(1);

    // Evict Opus client
    evictClient(opusId, "test eviction");
    expect(state.clients.has(opusId)).toBe(false);
    expect(state.opusClients.has(opusId)).toBe(false);
    expect(state.listenersOpus).toBe(0);
  });
});
