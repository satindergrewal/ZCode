import type {
  PluginCommand,
  McpServerStatus,
  SkillSummary,
  UserCommand,
  ZCodeCommand,
  ZCodeMcpServer,
  ZCodeMcpServerStatusSnapshot,
  ZCodePluginInfo,
  ZCodePluginComponentKind,
  ZCodePluginsDescribeResult,
} from "@zcode/shared";
import { isPluginCommand, isUserCommand, ZCODE_COMMAND_AGENT_SOURCE } from "@zcode/shared";
import type { PluginComponentDisplayGroup } from "@/settings/PluginComponentGroups.js";

export interface ResourceGroups<TLocal, TPlugin> {
  local: TLocal[];
  plugin: TPlugin[];
}

/** Detail-group display order, matching describeResultToDisplayGroups / buildInstalledPluginDisplayGroups. */
const COMPONENT_KIND_ORDER: ZCodePluginComponentKind[] = [
  "agent",
  "command",
  "skill",
  "hook",
  "mcp",
];

/**
 // Map plugins/describe's on-demand result into the shared display groups (name+description), fixed order,
 // empty groups omitted. Counts use items.length (describe is the authoritative enumeration).
 */
export function describeResultToDisplayGroups(
  result: ZCodePluginsDescribeResult,
): PluginComponentDisplayGroup[] {
  const byKind = new Map<ZCodePluginComponentKind, PluginComponentDisplayGroup>();
  for (const group of result.components) {
    if (group.items.length === 0) continue;
    byKind.set(group.kind, {
      kind: group.kind,
      count: group.items.length,
      items: group.items.map((item) => ({
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
      })),
    });
  }
  return COMPONENT_KIND_ORDER.map((kind) => byKind.get(kind)).filter(
    (group): group is PluginComponentDisplayGroup => group !== undefined,
  );
}

/**
 // Map the authoritative components from plugins/list (name+description) into the shared display groups, same logic as
 // describeResultToDisplayGroups: fixed order, empty groups omitted, count items.length.
 *
 // The installed-detail dialog used buildPluginComponentGroups: count from protocol skillCount, names via
 // a UI-side join (skillsService filtered by pluginName). The split sources made disabled plugins vanish wholesale and
 // enabled ones count-only. The CLI now authoritatively enumerates plugin roots and ships components with list;
 // use it directly and drop the fragile join.
 */
export function buildInstalledPluginDisplayGroups(
  plugin: ZCodePluginInfo,
): PluginComponentDisplayGroup[] {
  const byKind = new Map<ZCodePluginComponentKind, PluginComponentDisplayGroup>();
  for (const group of plugin.components ?? []) {
    if (group.items.length === 0) continue;
    byKind.set(group.kind, {
      kind: group.kind,
      count: group.items.length,
      items: group.items.map((item) => ({
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
      })),
    });
  }
  return COMPONENT_KIND_ORDER.map((kind) => byKind.get(kind)).filter(
    (group): group is PluginComponentDisplayGroup => group !== undefined,
  );
}

export interface PluginMcpServerItem {
  active: boolean;
  authorization?: ZCodeMcpServerStatusSnapshot["authorization"];
  error?: string;
  failureKind?: ZCodeMcpServerStatusSnapshot["failureKind"];
  id: string;
  hostProvided?: boolean;
  name: string;
  pluginEnabled: boolean;
  pluginId: string;
  pluginMarketplace: string;
  pluginName: string;
  runtimeServerName: string;
  serverRequestId?: string;
  status?: McpServerStatus;
  toolCount?: number;
}

export interface PluginMcpServerGroup {
  items: PluginMcpServerItem[];
  pluginId: string;
  pluginName: string;
}

export function groupPluginMcpServersByPlugin(
  items: readonly PluginMcpServerItem[],
): PluginMcpServerGroup[] {
  const groups = new Map<string, PluginMcpServerGroup>();
  for (const item of items) {
    const group = groups.get(item.pluginId) ?? {
      items: [],
      pluginId: item.pluginId,
      pluginName: item.pluginName,
    };
    group.items.push(item);
    groups.set(item.pluginId, group);
  }
  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      items: group.items
        .map((item, index) => ({ index, item }))
        .toSorted((left, right) => {
          const leftAttention = Boolean(
            left.item.authorization?.authorizationUrl || left.item.status === "error",
          );
          const rightAttention = Boolean(
            right.item.authorization?.authorizationUrl || right.item.status === "error",
          );
          return Number(rightAttention) - Number(leftAttention) || left.index - right.index;
        })
        .map(({ item }) => item),
    }))
    .toSorted((left, right) =>
      left.pluginName.localeCompare(right.pluginName, undefined, {
        sensitivity: "base",
      }),
    );
}

function normalizedQueryMatches(query: string, values: readonly (string | undefined)[]): boolean {
  const keyword = query.trim().toLowerCase();
  if (!keyword) {
    return true;
  }
  return values.some((value) => value?.toLowerCase().includes(keyword));
}

export function groupSkillsByPlugin(
  skills: SkillSummary[],
  query: string,
): ResourceGroups<SkillSummary, SkillSummary> {
  const seenPaths = new Set<string>();
  const local: SkillSummary[] = [];
  const plugin: SkillSummary[] = [];
  for (const skill of skills) {
    const normalizedPath = skill.path.replaceAll("\\", "/").toLowerCase();
    if (seenPaths.has(normalizedPath)) {
      continue;
    }
    seenPaths.add(normalizedPath);
    if (!normalizedQueryMatches(query, [skill.name, skill.description, skill.pluginName])) {
      continue;
    }
    if (skill.scope === "plugin") {
      plugin.push(skill);
    } else {
      local.push(skill);
    }
  }
  return { local, plugin };
}

export function groupCommandsByPlugin(
  commands: ZCodeCommand[],
  query: string,
): ResourceGroups<UserCommand, PluginCommand> {
  const local: UserCommand[] = [];
  const plugin: PluginCommand[] = [];
  for (const command of commands) {
    if (
      isUserCommand(command) &&
      command.agentSource === ZCODE_COMMAND_AGENT_SOURCE &&
      normalizedQueryMatches(query, [command.name, command.description, command.prompt])
    ) {
      local.push(command);
      continue;
    }
    if (
      isPluginCommand(command) &&
      normalizedQueryMatches(query, [
        command.name,
        command.description,
        command.prompt,
        command.pluginName,
      ])
    ) {
      plugin.push(command);
    }
  }
  return { local, plugin };
}

export function filterLocalMcpServers(servers: ZCodeMcpServer[], query: string): ZCodeMcpServer[] {
  return servers.filter((server) => {
    if (server.source !== "zcodeagentmcp") {
      return false;
    }
    return normalizedQueryMatches(query, [server.name, server.config.url, server.config.command]);
  });
}

export function buildPluginMcpServerItems(
  plugins: ZCodePluginInfo[],
  query: string,
  statusSnapshots: Record<string, ZCodeMcpServerStatusSnapshot> = {},
): PluginMcpServerItem[] {
  return plugins.flatMap((plugin) => {
    const hostNames = new Set(plugin.hostMcpServerNames ?? []);
    const activeNames = new Set(plugin.mcpServerNames);
    const activeDisplayNames = new Set(
      plugin.mcpServerNames.flatMap((serverName) => [
        serverName,
        toPluginMcpServerDisplayName(plugin, serverName),
      ]),
    );
    const declaredNames = (plugin.declaredMcpServerNames ?? plugin.mcpServerNames).map(
      (serverName) => toPluginMcpServerDisplayName(plugin, serverName),
    );
    // The MCP management page shows plugin-builtin MCP even when disabled, so provenance stays visible.
    // mcpServerNames still means runtime-injected MCP; declaredMcpServerNames is read-only display.
    // Runtime injection prefixes plugin:<name>:; display must judge active by declared names, avoiding false not-loaded.
    const serverNames = Array.from(
      new Set([
        ...hostNames,
        ...declaredNames,
        ...plugin.mcpServerNames.map((serverName) =>
          toPluginMcpServerDisplayName(plugin, serverName),
        ),
      ]),
    );
    return serverNames
      .filter((serverName) => normalizedQueryMatches(query, [serverName, plugin.name, plugin.id]))
      .map((serverName) => {
        const hostProvided = hostNames.has(serverName);
        const runtimeServerName = hostProvided
          ? serverName
          : resolvePluginMcpRuntimeServerName(plugin, serverName);
        const mappedStatus =
          hostProvided || plugin.enabled
            ? mapPluginRuntimeStatus(statusSnapshots[runtimeServerName])
            : {};
        return {
          ...mappedStatus,
          active: hostProvided || activeNames.has(serverName) || activeDisplayNames.has(serverName),
          id: `${plugin.id}:${serverName}`,
          ...(hostProvided ? { hostProvided: true } : {}),
          name: serverName,
          pluginEnabled: plugin.enabled,
          pluginId: plugin.id,
          pluginMarketplace: plugin.marketplace,
          pluginName: plugin.name,
          runtimeServerName,
        };
      });
  });
}

function toPluginMcpServerDisplayName(plugin: ZCodePluginInfo, serverName: string): string {
  const namespacePrefix = `plugin:${plugin.name}:`;
  return serverName.startsWith(namespacePrefix)
    ? serverName.slice(namespacePrefix.length)
    : serverName;
}

function resolvePluginMcpRuntimeServerName(plugin: ZCodePluginInfo, displayName: string): string {
  const activeName = plugin.mcpServerNames.find(
    (serverName) =>
      serverName === displayName ||
      toPluginMcpServerDisplayName(plugin, serverName) === displayName,
  );
  return activeName ?? `plugin:${plugin.name}:${displayName}`;
}

function mapPluginRuntimeStatus(
  snapshot: ZCodeMcpServerStatusSnapshot | undefined,
): Pick<
  PluginMcpServerItem,
  "authorization" | "error" | "failureKind" | "serverRequestId" | "status" | "toolCount"
> {
  if (!snapshot) {
    return {};
  }

  switch (snapshot.status) {
    case "connected":
    case "connecting":
      return {
        authorization: snapshot.authorization,
        status: snapshot.status,
        toolCount: snapshot.toolCount,
      };
    case "disconnected":
      return {
        authorization: snapshot.authorization,
        error: snapshot.error,
        failureKind: snapshot.failureKind,
        serverRequestId: snapshot.serverRequestId,
        status: snapshot.status,
        toolCount: snapshot.toolCount,
      };
    case "failed":
      return {
        error: snapshot.error ?? "MCP server failed",
        failureKind: snapshot.failureKind ?? "connection_failed",
        serverRequestId: snapshot.serverRequestId,
        status: "error",
        toolCount: snapshot.toolCount,
      };
    case "disabled":
      return {
        error: snapshot.error,
        failureKind: snapshot.failureKind,
        serverRequestId: snapshot.serverRequestId,
        status: "unknown",
        toolCount: snapshot.toolCount,
      };
    case "untrusted":
      return {
        error: snapshot.error ?? "Project MCP server requires explicit connection before use.",
        failureKind: snapshot.failureKind ?? "status_unavailable",
        serverRequestId: snapshot.serverRequestId,
        status: "unknown",
        toolCount: snapshot.toolCount,
      };
  }
}
