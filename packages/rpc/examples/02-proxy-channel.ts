/**
 * Example 2: ProxyChannel -- service proxies with zero boilerplate
 *
 * Unlike the hand-written CalculatorChannel in example 1, ProxyChannel exposes a
 * service as a channel in one line and restores it as a service in one line.
 *
 * This is how hundreds of services in VS Code communicate across processes.
 */

import {
  Emitter,
  Event,
  DisposableStore,
  ChannelServer,
  ChannelClient,
  ProxyChannel,
  createQueuePair,
} from "../src/index.js";

// ============================================================================
// Service interface and implementation
// ============================================================================

/** File system service interface */
interface IFileService {
  onDidChangeFile: Event<{ path: string; type: string }>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listFiles(dir: string): Promise<string[]>;
}

/** In-memory file system implementation */
class InMemoryFileService implements IFileService {
  private files = new Map<string, string>();
  private readonly _onDidChangeFile = new Emitter<{ path: string; type: string }>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`File not found: ${path}`);
    }
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const isNew = !this.files.has(path);
    this.files.set(path, content);
    this._onDidChangeFile.fire({
      path,
      type: isNew ? "created" : "changed",
    });
  }

  async listFiles(dir: string): Promise<string[]> {
    return [...this.files.keys()].filter((p) => p.startsWith(dir));
  }
}

// ============================================================================
// ProxyChannel demo
// ============================================================================

async function main() {
  const [protocolA, protocolB] = createQueuePair();
  const disposables = new DisposableStore();

  // ========== Server ==========
  const fileService = new InMemoryFileService();

  // One line: service becomes channel!
  // ProxyChannel.fromService automatically:
  // - maps readFile, writeFile, listFiles to call
  // - maps onDidChangeFile to listen
  const channel = ProxyChannel.fromService<string>(fileService, disposables);

  const server = new ChannelServer(protocolB, "server");
  server.registerChannel("fileService", channel);

  // ========== Client ==========
  const client = new ChannelClient(protocolA);
  await Event.toPromise(client.onDidInitialize);

  // One line: channel becomes a type-safe service again!
  // Via ES6 Proxy, remoteFS.readFile(...) becomes channel.call('readFile', [...])
  const remoteFS = ProxyChannel.toService<IFileService>(client.getChannel("fileService"));

  // ========== Use the remote service (just like a local call!) ==========
  console.log("--- ProxyChannel Demo ---");
  console.log("(note: every call is serialized -> transported -> deserialized)\n");

  // Listen for file changes
  const eventDisposable = remoteFS.onDidChangeFile((e) => {
    console.log(`  [file event] ${e.type}: ${e.path}`);
  });

  // Write files
  await remoteFS.writeFile("/src/main.ts", 'console.log("hello")');
  await remoteFS.writeFile("/src/util.ts", "export function add(a, b) { return a + b; }");
  await remoteFS.writeFile("/src/main.ts", 'console.log("hello world")'); // update

  // Read a file back
  const content = await remoteFS.readFile("/src/main.ts");
  console.log(`\nreadFile('/src/main.ts') = "${content}"`);

  // List files
  const files = await remoteFS.listFiles("/src");
  console.log(`listFiles('/src') = ${JSON.stringify(files)}`);

  // Exercise error propagation
  try {
    await remoteFS.readFile("/nonexistent");
  } catch (err: any) {
    console.log(`readFile('/nonexistent') → Error: ${err.message}`);
  }

  // Clean up
  eventDisposable.dispose();
  client.dispose();
  server.dispose();
  disposables.dispose();

  console.log("\nDone!");
}

main().catch(console.error);
