/**
 * ServiceDescriptor — identifies a service by channel name and ties the type
 * via generics.
 *
 * Relies on TypeScript allowing an interface and a const with the same name
 * (types and values live in separate namespaces), so callers can reference both
 * the service type and the runtime descriptor by one name.
 */

export interface ServiceDescriptor<T> {
  readonly channelName: string;
  /** Phantom type — for type inference only, absent at runtime */
  readonly _brand?: T;
}

export function createServiceDescriptor<T>(channelName: string): ServiceDescriptor<T> {
  return { channelName };
}
