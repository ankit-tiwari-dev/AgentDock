import { SecretManager } from "./secret-manager.ts";
import type { SecretStorageLike } from "./types.ts";
import { AgentDockSidebarProvider } from "./sidebar-provider.ts";

export interface ExtensionContextLike {
  secrets: SecretStorageLike;
  subscriptions: Array<{ dispose(): unknown }>;
}

export function activateExtension(context: ExtensionContextLike): {
  secretManager: SecretManager;
  sidebarProvider: AgentDockSidebarProvider;
} {
  const secretManager = new SecretManager(context.secrets);
  const sidebarProvider = new AgentDockSidebarProvider(secretManager);

  return { secretManager, sidebarProvider };
}

