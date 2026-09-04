import fs from "fs";
import { McpServer } from "mcp-lite";
import { createInterface } from "readline";
import { state } from "./state";
import { config } from "./config";
import { actionSkipFallback, reshufflePlaylist, startFallback, stopFallback } from "./audio-router";

// Create the MCP server
const server = new McpServer({
  name: "bunradio-mcp-server",
  version: "1.0.0",
});

// 1. Get Status
server.tool("get_status", {
  description: "Get the current status of the radio station, including broadcasting state, listener counts, and active track details",
  handler: async () => {
    try {
      const uptimeSeconds = Math.floor((Date.now() - state.startTime.getTime()) / 1000);
      const status = {
        broadcasting: state.isBroadcasting,
        sourceConnected: state.sourceConnected,
        listeners: state.clients.size,
        maxListeners: config.maxListeners,
        totalListenersServed: state.totalListenersServed,
        totalBytesReceived: state.totalBytesReceived,
        totalBytesSent: state.totalBytesSent,
        uptimeSeconds,
        stationName: "BunRadio",
        detectedBitrateKbps: state.detectedBitrateKbps,
        detectedSampleRate: state.detectedSampleRate,
        fallbackBitrateKbps: config.fallbackBitrateKbps,
        fallbackActive: !state.isBroadcasting && state.currentTrack !== null,
        currentTrack: state.currentTrack,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 2. Get Queue
server.tool("get_queue", {
  description: "Retrieve the current playback priority queue",
  handler: async () => {
    try {
      return {
        content: [{ type: "text", text: JSON.stringify({ queue: state.fallbackQueue }, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 3. Push to Queue
server.tool("push_to_queue", {
  description: "Add a local audio file path or remote stream URL (e.g. http/rtmp) to the playback queue",
  inputSchema: {
    type: "object",
    properties: {
      file: { type: "string", description: "Path to the local file or URL to enqueue" }
    },
    required: ["file"]
  },
  handler: async ({ file }: any) => {
    try {
      if (!file || typeof file !== "string") throw new Error("Parameter 'file' invalid");
      state.fallbackQueue.push(file);
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, queue: state.fallbackQueue }, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 4. Remove from Queue
server.tool("remove_from_queue", {
  description: "Remove an item from the priority queue by its 0-based index",
  inputSchema: {
    type: "object",
    properties: {
      index: { type: "integer", minimum: 0, description: "The index of the item to remove" }
    },
    required: ["index"]
  },
  handler: async ({ index }: any) => {
    try {
      const idx = Number(index);
      if (Number.isNaN(idx) || idx < 0 || idx >= state.fallbackQueue.length) throw new Error("Parameter 'index' out of range");
      state.fallbackQueue.splice(idx, 1);
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, queue: state.fallbackQueue }, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 5. Clear Queue
server.tool("clear_queue", {
  description: "Clear all tracks from the priority queue",
  handler: async () => {
    try {
      state.fallbackQueue = [];
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, queue: [] }, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 6. Move in Queue
server.tool("move_in_queue", {
  description: "Move a track in the priority queue from one position to another",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "integer", minimum: 0, description: "Source index of the track" },
      to: { type: "integer", minimum: 0, description: "Destination index of the track" }
    },
    required: ["from", "to"]
  },
  handler: async ({ from, to }: any) => {
    try {
      const f = Number(from);
      const t = Number(to);
      if (Number.isNaN(f) || f < 0 || f >= state.fallbackQueue.length || Number.isNaN(t) || t < 0 || t >= state.fallbackQueue.length) {
        throw new Error("Valores 'from' o 'to' fuera de rango");
      }
      const [movedItem] = state.fallbackQueue.splice(f, 1);
      if (movedItem) state.fallbackQueue.splice(t, 0, movedItem);
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, queue: state.fallbackQueue }, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 7. Skip Track
server.tool("skip_track", {
  description: "Skip the current song. Note: Live RTMP streams cannot be skipped, only fallback tracks",
  handler: async () => {
    try {
      if (!state.isBroadcasting && state.currentTrack) {
        actionSkipFallback();
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, message: "Skipping track..." }, null, 2) }],
        };
      }
      throw new Error("Live cannot be skipped, stop stream from OBS or no active track");
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 8. Shuffle Playlist
server.tool("shuffle_playlist", {
  description: "Reshuffle the fallback playlist and restart playback from the first track",
  handler: async () => {
    try {
      reshufflePlaylist();
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true }, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 9. List Files
server.tool("list_files", {
  description: "List the available audio files in the local fallback directory configured on the server",
  handler: async () => {
    try {
      if (!config.fallbackSource) return { content: [{ type: "text", text: JSON.stringify({ files: [] }, null, 2) }] };
      const stat = fs.statSync(config.fallbackSource);
      let files: string[] = [];
      if (stat.isDirectory()) {
        files = fs.readdirSync(config.fallbackSource)
          .filter((f) => /\.(mp3|flac|wav|m4a|aac|ogg)$/i.test(f))
          .map((f) => `${config.fallbackSource}/${f}`);
      } else {
        files = [config.fallbackSource];
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ files }, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

// 10. Toggle Fallback
server.tool("toggle_fallback", {
  description: "Toggle (pause or resume) fallback music playback when no live stream is active",
  handler: async () => {
    try {
      state.fallbackPaused = !state.fallbackPaused;
      if (state.fallbackPaused) {
        stopFallback();
      } else {
        startFallback();
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, paused: state.fallbackPaused }, null, 2) }],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
});

export { server as mcpServer };

// Stdio transport implementation using readline interface, run only if called directly
if (import.meta.main) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    try {
      const request = JSON.parse(line);
      const response = await server._dispatch(request);
      if (response) {
        console.log(JSON.stringify(response));
      }
    } catch (error: any) {
      const errResponse = {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${error.message}`,
        },
      };
      console.log(JSON.stringify(errResponse));
    }
  });

  console.error("BunRadio MCP Server is running over Stdio.");
}
