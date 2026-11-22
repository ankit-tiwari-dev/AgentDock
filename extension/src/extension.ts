import { AgentDockSidebarProvider } from "./sidebar-provider.ts";

export interface ExtensionContextLike {
  subscriptions: Array<{ dispose(): unknown }>;
}

export function activateExtension(_context: ExtensionContextLike): { sidebarProvider: AgentDockSidebarProvider } {
  return { sidebarProvider: new AgentDockSidebarProvider() };
}
