import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { CommandLinkService, type ShortLinkResult } from "../src/command.ts";
import { loadConfig } from "../src/config.ts";
import { registerShortLinkEventService } from "../src/events.ts";
import { ShortLinkService, type CreatedShortLink } from "../src/links.ts";
import { RedirectServer, type RunningServer } from "../src/server.ts";
import { JsonLinkStore } from "../src/store.ts";
import { isExpired, type CreateLinkInput } from "../src/types.ts";

const CreateShortLinkParameters = Type.Object({
  url: Type.String({ description: "Absolute http(s) URL to shorten" }),
  title: Type.Optional(
    Type.String({
      description: "Human-readable title used in the slug prefix",
    }),
  ),
  description: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
  slug: Type.Optional(
    Type.String({
      description: "Optional custom slug; letters, numbers, and hyphens only",
    }),
  ),
  expiresIn: Type.Optional(
    StringEnum(["1h", "1d", "7d", "30d", "never"] as const),
  ),
  dedupe: Type.Optional(Type.Boolean()),
});
type CreateShortLinkParameters = Static<typeof CreateShortLinkParameters>;

export default function shortLinksExtension(pi: ExtensionAPI) {
  const config = loadConfig();
  const store = new JsonLinkStore(config.storePath, {
    secureDirectory: config.secureStoreDirectory,
  });
  const server = new RedirectServer(config.server, store);
  const links = new ShortLinkService(store, server);
  const commandLinks = config.command
    ? new CommandLinkService(config.command)
    : null;

  // One entry point for the tool, the commands, and the event service: the configured
  // command when PI_SHORT_LINKS_COMMAND is set, otherwise the local store and server.
  async function createLink(
    input: CreateLinkInput,
    source: "tool" | "command" | "extension",
  ): Promise<ShortLinkResult & { local?: CreatedShortLink }> {
    if (commandLinks) return commandLinks.create(input);
    const created = await links.create(input, source);
    return {
      shortUrl: shortUrl(created.server, created.link.slug),
      localOnly: true,
      warnings: created.warnings,
      local: created,
    };
  }

  const unsubscribeEventService = registerShortLinkEventService(pi.events, {
    async create(input, source) {
      const { shortUrl, localOnly, warnings } = await createLink(input, source);
      return { shortUrl, localOnly, warnings };
    },
  });

  pi.registerTool({
    name: "create_short_link",
    label: "Create Short Link",
    description: commandLinks
      ? "Create a short link for a URL with the configured short-link command."
      : "Create a local short link for a URL. The link works only on this machine while Pi's short-links server is running.",
    promptSnippet: commandLinks
      ? "Create short links for long URLs generated during the session."
      : "Create local short links for long URLs generated during the session.",
    promptGuidelines: commandLinks
      ? [
          "Use create_short_link when the user asks for a short link or when a generated URL is too long to share comfortably.",
        ]
      : [
          "Use create_short_link when the user asks for a short link or when a generated URL is too long to share comfortably.",
          "Always tell the user that create_short_link returns a local-only link that works only on this machine while Pi's short-links server is running.",
          "Do not use create_short_link when the user needs a link that teammates can open.",
        ],
    parameters: CreateShortLinkParameters,
    async execute(_toolCallId, parameters) {
      const result = await createLink(parameters as CreateLinkInput, "tool");
      const created = result.local;
      return {
        content: [{ type: "text", text: resultText(result) }],
        details: created
          ? {
              shortUrl: result.shortUrl,
              targetUrl: created.link.targetUrl,
              slug: created.link.slug,
              localOnly: true,
              deduped: created.deduped,
              collisionResolved: created.collisionResolved,
              expiresAt: created.link.expiresAt,
              warnings: created.warnings,
              server: created.server,
            }
          : {
              shortUrl: result.shortUrl,
              localOnly: false,
              warnings: result.warnings,
            },
      };
    },
  });

  pi.registerCommand("short-link", {
    description: "Create a short link: /short-link <url>",
    handler: async (argumentsText, context) => {
      try {
        const url = argumentsText.trim();
        if (!url) throw new Error("Usage: /short-link <url>");
        notify(context, resultText(await createLink({ url }, "command")));
      } catch (error: unknown) {
        notify(context, errorMessage(error), "error");
      }
    },
  });

  pi.registerCommand("short-links", {
    description: "Manage short links: create/list/start/stop/status",
    handler: async (argumentsText, context) => {
      const [command, ...rest] = argumentsText.trim().split(/\s+/);
      const remaining = rest.join(" ");

      try {
        if (!command || command === "help") {
          notify(
            context,
            "Usage: /short-links create <url> | list | start | stop | status",
          );
          return;
        }

        if (command === "create") {
          if (!remaining) {
            throw new Error("Usage: /short-links create <url>");
          }
          notify(
            context,
            resultText(await createLink({ url: remaining }, "command")),
          );
          return;
        }

        if (command === "list") {
          notify(context, await listText(store, server));
          return;
        }

        if (command === "start") {
          const running = await server.start();
          notify(
            context,
            `Short-links server running at http://${running.host}:${running.port}\nLocal-only; works only on this machine while Pi is running.`,
          );
          return;
        }

        if (command === "stop") {
          const stopped = await server.stop();
          notify(
            context,
            stopped
              ? "Short-links server stopped. Stored links remain saved."
              : "Short-links server was already stopped.",
          );
          return;
        }

        if (command === "status") {
          const data = await store.read();
          const status = server.status();
          notify(
            context,
            `Short-links server: ${status.running ? `running at http://${status.host}:${status.port}` : "stopped"}\nStore: ${store.filePath}\nLinks: ${Object.keys(data.links).length}\n${commandLinks ? "New links: created by PI_SHORT_LINKS_COMMAND." : "Local-only; set PI_SHORT_LINKS_COMMAND for team-shareable links."}`,
          );
          return;
        }

        notify(
          context,
          `Unknown subcommand: ${command}. Use create/list/start/stop/status.`,
          "warning",
        );
      } catch (error: unknown) {
        notify(context, errorMessage(error), "error");
      }
    },
  });

  pi.on("session_shutdown", async () => {
    unsubscribeEventService();
    await server.stop();
  });
}

async function listText(
  store: JsonLinkStore,
  server: RedirectServer,
): Promise<string> {
  const data = await store.read();
  const links = Object.values(data.links).sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
  if (links.length === 0) {
    return `No short links saved. Store: ${store.filePath}`;
  }

  return links
    .map((link) => {
      const activeUrl = server.urlFor(link.slug);
      const location = activeUrl
        ? `\n  ${activeUrl}`
        : "\n  server stopped; run /short-links start to activate this link";
      const expiry = link.expiresAt
        ? isExpired(link)
          ? "expired"
          : link.expiresAt
        : "never";
      return `${link.slug}${link.title ? ` - ${link.title}` : ""}${location}\n  created ${link.createdAt}; expires ${expiry}; accesses ${link.accessCount}`;
    })
    .join("\n");
}

function shortUrl(server: RunningServer, slug: string): string {
  return `http://${server.host}:${server.port}/s/${encodeURIComponent(slug)}`;
}

function resultText({
  shortUrl,
  localOnly,
  warnings,
}: ShortLinkResult): string {
  return [
    ...(localOnly
      ? [
          `Local short link: ${shortUrl}`,
          "Works only on this machine while Pi's short-links server is running.",
        ]
      : [`Short link: ${shortUrl}`]),
    ...warnings.map((warning) => `Warning: ${warning}`),
  ].join("\n");
}

function notify(
  context: ExtensionCommandContext,
  text: string,
  level: "info" | "warning" | "error" = "info",
): void {
  if (context.hasUI) context.ui.notify(text, level);
  else console.log(text);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
