import { SecretManager } from "./secret-manager.ts";
import { AgentDockSidebarProvider } from "./sidebar-provider.ts";

export interface ExtensionContextLike {
  secrets: any;
  subscriptions: Array<{ dispose(): any }>;
}

export function activateExtension(context: ExtensionContextLike): {
  secretManager: SecretManager;
  sidebarProvider: AgentDockSidebarProvider;
} {
  const secretManager = new SecretManager(context.secrets);
  const sidebarProvider = new AgentDockSidebarProvider(secretManager);

  return { secretManager, sidebarProvider };
}
