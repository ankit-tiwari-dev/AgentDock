import { basename, resolve } from "node:path";
import { AuditReader } from "./audit-reader.ts";
import type { CodexRoleService } from "./codex-role-service.ts";

export type CodexRoles = Pick<CodexRoleService, "interview" | "review">;

export interface ProjectInfo {
  id: string;
  name: string;
  projectPath: string;
}

export interface Project extends ProjectInfo {
  reader: AuditReader;
  codex: CodexRoles;
}

/** One entry per distinct folder, in the order given; the id is what requests use, so they never carry a path. */
export function projectIds(paths: string[]): ProjectInfo[] {
  const seen = new Set<string>();
  const used = new Set<string>();
  const listed: ProjectInfo[] = [];
  for (const raw of paths) {
    const projectPath = resolve(raw);
    const key = process.platform === "win32" ? projectPath.toLowerCase() : projectPath;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = basename(projectPath) || projectPath;
    const base =
      name
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .join("-") || "project";
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    listed.push({ id, name, projectPath });
  }
  return listed;
}

export class ProjectRegistry {
  private readonly projects: Project[];

  constructor(paths: string[], codexFor: (projectPath: string) => CodexRoles) {
    this.projects = projectIds(paths).map((info) => ({
      ...info,
      reader: new AuditReader(info.projectPath),
      codex: codexFor(info.projectPath),
    }));
  }

  all(): readonly Project[] {
    return this.projects;
  }

  /** No id means the first project, so callers that predate several projects keep working; an unknown id is undefined. */
  find(id: string | null | undefined): Project | undefined {
    if (id === null || id === undefined) return this.projects[0];
    return this.projects.find((project) => project.id === id);
  }
}
