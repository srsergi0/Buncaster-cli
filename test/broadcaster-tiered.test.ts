import { describe, expect, it } from "bun:test";

interface MockClient {
  id: string;
  tier: "mp3" | "opus";
  enqueuedChunks: Uint8Array[];
  bytesSent: number;
}

export class TieredBroadcaster {
  public mp3Clients = new Map<string, MockClient>();
  public opusClients = new Map<string, MockClient>();
  public totalBytesSentMp3 = 0;
  public totalBytesSentOpus = 0;

  addClient(id: string, tier: "mp3" | "opus"): MockClient {
    const client: MockClient = {
      id,
      tier,
      enqueuedChunks: [],
      bytesSent: 0,
    };
    if (tier === "mp3") {
      this.mp3Clients.set(id, client);
    } else {
      this.opusClients.set(id, client);
    }
    return client;
  }

  removeClient(id: string): void {
    this.mp3Clients.delete(id);
    this.opusClients.delete(id);
  }

  get listenersMp3(): number {
    return this.mp3Clients.size;
  }

  get listenersOpus(): number {
    return this.opusClients.size;
  }

  get totalListeners(): number {
    return this.mp3Clients.size + this.opusClients.size;
  }

  broadcastMp3(chunk: Uint8Array): void {
    // Immutable copy
    const data = new Uint8Array(chunk);
    for (const [_, client] of this.mp3Clients) {
      client.enqueuedChunks.push(data);
      client.bytesSent += data.byteLength;
      this.totalBytesSentMp3 += data.byteLength;
    }
  }

  broadcastOpus(chunk: Uint8Array): void {
    const data = new Uint8Array(chunk);
    for (const [_, client] of this.opusClients) {
      client.enqueuedChunks.push(data);
      client.bytesSent += data.byteLength;
      this.totalBytesSentOpus += data.byteLength;
    }
  }
}

describe("Tiered Broadcaster", () => {
  it("only delivers MP3 chunks to MP3 clients and Opus chunks to Opus clients", () => {
    const b = new TieredBroadcaster();
    const mp3Client = b.addClient("c1", "mp3");
    const opusClient = b.addClient("c2", "opus");

    expect(b.listenersMp3).toBe(1);
    expect(b.listenersOpus).toBe(1);
    expect(b.totalListeners).toBe(2);

    const mp3Chunk = new Uint8Array([1, 2, 3]);
    b.broadcastMp3(mp3Chunk);

    expect(mp3Client.enqueuedChunks.length).toBe(1);
    expect(opusClient.enqueuedChunks.length).toBe(0);

    const opusChunk = new Uint8Array([4, 5]);
    b.broadcastOpus(opusChunk);

    expect(mp3Client.enqueuedChunks.length).toBe(1);
    expect(opusClient.enqueuedChunks.length).toBe(1);

    b.removeClient("c1");
    expect(b.listenersMp3).toBe(0);
    expect(b.listenersOpus).toBe(1);
  });
});
