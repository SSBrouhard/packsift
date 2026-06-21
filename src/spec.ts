import { PackageSpec } from "./types.js";

export function parsePackageSpec(raw: string): PackageSpec {
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) {
    throw new Error(`Expected package spec in the form name@version: ${raw}`);
  }

  return {
    raw,
    name: raw.slice(0, at),
    version: raw.slice(at + 1)
  };
}

export function assertSamePackage(oldSpec: PackageSpec, newSpec: PackageSpec): void {
  if (oldSpec.name !== newSpec.name) {
    throw new Error(`Package names differ: ${oldSpec.name} vs ${newSpec.name}`);
  }
}
