/**
 * AgentDock Web Dashboard Client Types and Configuration
 */

export type DashboardTab =
  | "overview"
  | "wizard"
  | "coach"
  | "stream"
  | "verifier"
  | "diff";

export interface DashboardConfig {
  backendHost: string;
  backendPort: number;
  wsEndpoint: string;
}

export const DEFAULT_DASHBOARD_CONFIG: DashboardConfig = {
  backendHost: "127.0.0.1",
  backendPort: 45820,
  wsEndpoint: "/ws/events",
};
