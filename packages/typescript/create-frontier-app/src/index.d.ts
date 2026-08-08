export interface ScaffoldResult {
  targetDir: string;
  projectName: string;
  files: string[];
}

export interface ScaffoldOptions {
  cwd?: string;
  projectName?: string;
}

export const TEMPLATE_MANIFEST: readonly string[];
export function sanitizePackageName(name: string): string;
export function validateTargetDir(targetDir: string, options?: ScaffoldOptions): string;
export function scaffoldProject(targetDir: string, options?: ScaffoldOptions): ScaffoldResult;
export function formatNextSteps(result: ScaffoldResult): string;
