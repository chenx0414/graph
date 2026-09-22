/** A project as the console sees it: the live branch plus the prepared snapshot. */
export interface ProjectBranchView {
  id: string;
  branch?: string | null;
  preparation?: { branch?: string | null } | null;
}

/** The branch a new task should target, or null when nothing trustworthy is known. */
export function defaultTargetBranch(projects: ProjectBranchView[] | null | undefined, projectId: string | null | undefined): string | null {
  if (!projectId) return null;
  const project = projects?.find(item => item.id === projectId);
  const branch = (project?.branch ?? project?.preparation?.branch ?? '').trim();
  return branch ? branch : null;
}
