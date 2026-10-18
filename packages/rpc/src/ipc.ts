/**
 * Layer 4: connection management -- IPCServer and IPCClient
 *
 * ChannelServer/ChannelClient are the single-connection RPC implementation.
 * IPCServer/IPCClient build connection management on top:
 *
 * - IPCServer (1:N): one server accepts many client connections; each connection
 *   gets its own ChannelServer + ChannelClient. A Router picks the target client.
 *
 * - IPCClient (1:1 bidirectional): both client and server; it can call remote channels
 *   and register its own channels for the remote side to call.
 *
 * Key protocol: the first message a client sends after connecting is ctx
 * (context/client ID); the server uses it to identify the client.
 */

import {
  Event,
  Emitter,
  IDisposable,
  DisposableStore,
  CancellationToken,
  EventMultiplexer,
} from "./foundation.js";
import { BufferReader, BufferWriter, serialize, deserialize } from "./serialization.js";
import { IMessagePassingProtocol } from "./protocol.js";
import {
  IChannel,
  IServerChannel,
  IChannelServer,
  IChannelClient,
  ChannelServer,
  ChannelClient,
  getDelayedChannel,
} from "./channels.js";

// ============================================================================
// Connection-related interfaces
// ============================================================================

/** Client connection event */
export interface ClientConnectionEvent {
  protocol: IMessagePassingProtocol;
  readonly onDidClientDisconnect: Event<void>;
}

/** Client identity */
export interface Client<TContext> {
  readonly ctx: TContext;
}

/** Connection = client identity + bidirectional channels */
interface Connection<TContext> extends Client<TContext> {
  readonly channelServer: ChannelServer<TContext>;
  readonly channelClient: ChannelClient;
}

/** Connection hub -- exposes all live connections */
export interface IConnectionHub<TContext> {
  readonly connections: Connection<TContext>[];
  readonly onDidAddConnection: Event<Connection<TContext>>;
  readonly onDidRemoveConnection: Event<Connection<TContext>>;
}

/** Router -- picks the target client among many */
export interface IClientRouter<TContext = string> {
  routeCall(
    hub: IConnectionHub<TContext>,
    command: string,
    arg?: any,
    cancellationToken?: CancellationToken,
  ): Promise<Client<TContext>>;
  routeEvent(hub: IConnectionHub<TContext>, event: string, arg?: any): Promise<Client<TContext>>;
}

// ============================================================================
// IPCServer -- one-to-many server side
// ============================================================================

/**
 * IPCServer is the "brain" of the communication architecture.
 *
 * It is all of the following:
 * - IChannelServer: registers channels for clients to call
 * - IRoutingChannelClient: calls back into client channels (router-selected)
 * - IConnectionHub: exposes live connections with add/remove events
 *
 * Flow:
 * 1. Listen on onDidClientConnect
 * 2. After a client connects, wait for the first message (ctx = client ID)
 * 3. Create a dedicated ChannelServer + ChannelClient per connection
 * 4. Push registered channels onto the new connection's ChannelServer
 */
export class IPCServer<TContext = string>
  implements IChannelServer<TContext>, IConnectionHub<TContext>, IDisposable
{
  private channels = new Map<string, IServerChannel<TContext>>();
  private _connections = new Set<Connection<TContext>>();

  private readonly _onDidAddConnection = new Emitter<Connection<TContext>>();
  readonly onDidAddConnection = this._onDidAddConnection.event;

  private readonly _onDidRemoveConnection = new Emitter<Connection<TContext>>();
  readonly onDidRemoveConnection = this._onDidRemoveConnection.event;

  private readonly disposables = new DisposableStore();

  get connections(): Connection<TContext>[] {
    return [...this._connections];
  }

  constructor(onDidClientConnect: Event<ClientConnectionEvent>) {
    this.disposables.add(
      onDidClientConnect(({ protocol, onDidClientDisconnect }) => {
        // Wait for the client's first message: ctx (client identity)
        const onFirstMessage = Event.once(protocol.onMessage);

        this.disposables.add(
          onFirstMessage((msg) => {
            const reader = new BufferReader(msg);
            const ctx = deserialize(reader) as TContext;

            // Create a dedicated ChannelServer and ChannelClient for this connection
            const channelServer = new ChannelServer(protocol, ctx);
            const channelClient = new ChannelClient(protocol);

            // Push registered channels to the new connection
            this.channels.forEach((channel, name) => channelServer.registerChannel(name, channel));

            const connection: Connection<TContext> = { channelServer, channelClient, ctx };
            this._connections.add(connection);
            this._onDidAddConnection.fire(connection);

            // Clean up when the client disconnects
            this.disposables.add(
              onDidClientDisconnect(() => {
                channelServer.dispose();
                channelClient.dispose();
                this._connections.delete(connection);
                this._onDidRemoveConnection.fire(connection);
              }),
            );
          }),
        );
      }),
    );
  }

  /**
   * Get a client channel (reverse call).
   *
   * With multiple clients, a router or filter picks the target:
   * - router: implements IClientRouter with custom routing logic
   * - filter: a plain predicate; a random matching client wins
   */
  getChannel<T extends IChannel>(
    channelName: string,
    routerOrFilter: IClientRouter<TContext> | ((client: Client<TContext>) => boolean),
  ): T {
    const that = this;
    const isFilter = typeof routerOrFilter === "function";

    return {
      call(command: string, arg?: any, cancellationToken?: CancellationToken): Promise<any> {
        let connectionPromise: Promise<Client<TContext>>;

        if (isFilter) {
          const match = that.connections.find(routerOrFilter as (c: Client<TContext>) => boolean);
          connectionPromise = match
            ? Promise.resolve(match)
            : Event.toPromise(
                Event.filter(
                  that.onDidAddConnection,
                  routerOrFilter as (c: Client<TContext>) => boolean,
                ),
              );
        } else {
          connectionPromise = (routerOrFilter as IClientRouter<TContext>).routeCall(
            that,
            command,
            arg,
            cancellationToken,
          );
        }

        const channelPromise = connectionPromise.then((c) =>
          (c as Connection<TContext>).channelClient.getChannel(channelName),
        );

        return getDelayedChannel(channelPromise).call(command, arg, cancellationToken);
      },
      listen(event: string, arg?: any): Event<any> {
        if (isFilter) {
          return that.getMulticastEvent(
            channelName,
            routerOrFilter as (c: Client<TContext>) => boolean,
            event,
            arg,
          );
        }

        const channelPromise = (routerOrFilter as IClientRouter<TContext>)
          .routeEvent(that, event, arg)
          .then((c) => (c as Connection<TContext>).channelClient.getChannel(channelName));

        return getDelayedChannel(channelPromise).listen(event, arg);
      },
    } as T;
  }

  /** Multiplex the same event across all matching clients */
  private getMulticastEvent<T>(
    channelName: string,
    filter: (c: Client<TContext>) => boolean,
    eventName: string,
    arg: any,
  ): Event<T> {
    const that = this;
    let disposables: DisposableStore | undefined;

    const emitter = new Emitter<T>({
      onWillAddFirstListener: () => {
        disposables = new DisposableStore();
        const multiplexer = new EventMultiplexer<T>();

        const onAdd = (connection: Connection<TContext>) => {
          const channel = connection.channelClient.getChannel(channelName);
          const event = channel.listen<T>(eventName, arg);
          multiplexer.add(event);
        };

        that.connections.filter(filter).forEach(onAdd);
        disposables.add(Event.filter(that.onDidAddConnection, filter)(onAdd));
        disposables.add(multiplexer.event((e) => emitter.fire(e)));
        disposables.add(multiplexer);
      },
      onDidRemoveLastListener: () => {
        disposables?.dispose();
        disposables = undefined;
      },
    });

    return emitter.event;
  }

  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.channels.set(channelName, channel);

    // Push to all connected clients
    for (const connection of this._connections) {
      connection.channelServer.registerChannel(channelName, channel);
    }
  }

  dispose(): void {
    this.disposables.dispose();
    for (const connection of this._connections) {
      connection.channelClient.dispose();
      connection.channelServer.dispose();
    }
    this._connections.clear();
    this.channels.clear();
    this._onDidAddConnection.dispose();
    this._onDidRemoveConnection.dispose();
  }
}

// ============================================================================
// IPCClient -- one-to-one bidirectional
// ============================================================================

/**
 * IPCClient is bidirectional:
 * - call remote channels (IChannelClient)
 * - register own channels for the remote side (IChannelServer)
 *
 * The first message carries ctx (its own identity) so the server knows who it is.
 */
export class IPCClient<TContext = string>
  implements IChannelClient, IChannelServer<TContext>, IDisposable
{
  private channelClient: ChannelClient;
  private channelServer: ChannelServer<TContext>;

  constructor(protocol: IMessagePassingProtocol, ctx: TContext) {
    // First message: send our identity
    const writer = new BufferWriter();
    serialize(writer, ctx);
    protocol.send(writer.buffer);

    this.channelClient = new ChannelClient(protocol);
    this.channelServer = new ChannelServer(protocol, ctx);
  }

  getChannel<T extends IChannel>(channelName: string): T {
    return this.channelClient.getChannel(channelName);
  }

  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.channelServer.registerChannel(channelName, channel);
  }

  dispose(): void {
    this.channelClient.dispose();
    this.channelServer.dispose();
  }
}

// ============================================================================
// StaticRouter -- trivial router
// ============================================================================

/**
 * Router that selects clients by a static predicate.
 * Example: new StaticRouter(ctx => ctx === 'main-window')
 */
export class StaticRouter<TContext = string> implements IClientRouter<TContext> {
  constructor(private fn: (ctx: TContext) => boolean | Promise<boolean>) {}

  async routeCall(hub: IConnectionHub<TContext>): Promise<Client<TContext>> {
    return this.route(hub);
  }

  async routeEvent(hub: IConnectionHub<TContext>): Promise<Client<TContext>> {
    return this.route(hub);
  }

  private async route(hub: IConnectionHub<TContext>): Promise<Client<TContext>> {
    for (const connection of hub.connections) {
      if (await Promise.resolve(this.fn(connection.ctx))) {
        return connection;
      }
    }
    // Wait for a new connection
    await Event.toPromise(hub.onDidAddConnection);
    return this.route(hub);
  }
}
