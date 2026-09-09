export function deploymentLabel(value: string | undefined): string {
  return value?.trim() || "Local development";
}
