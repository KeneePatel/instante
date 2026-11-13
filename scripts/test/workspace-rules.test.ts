import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The install rules and exact versions are part of the quality bar: this test fails
// if a change loosens them (CONSTRAINTS.md, "This bar isn't weakened").

const root = new URL('../../', import.meta.url);
const workspace = readFileSync(new URL('pnpm-workspace.yaml', root), 'utf8');

function setting(name: string): string | undefined {
  return new RegExp(`^${name}:[ \\t]*(\\S+)`, 'm').exec(workspace)?.[1];
}

describe('pnpm-workspace.yaml', () => {
  it('installs nothing younger than 7 days, strictly', () => {
    expect(setting('minimumReleaseAge')).toBe('10080');
    expect(setting('minimumReleaseAgeStrict')).toBe('true');
  });

  it('fails on unreviewed dependency build scripts', () => {
    expect(setting('strictDepBuilds')).toBe('true');
    expect(setting('dangerouslyAllowAllBuilds')).toBeUndefined();
  });

  it('saves exact versions', () => {
    expect(setting('saveExact')).toBe('true');
  });

  it('keeps package links inside the checkout', () => {
    expect(setting('enableGlobalVirtualStore')).toBe('false');
  });
});

describe('package.json files', () => {
  const manifests = ['package.json', 'apps/web/package.json'];

  it.each(manifests)('%s pins every dependency to an exact version', (path) => {
    const manifest = JSON.parse(readFileSync(new URL(path, root), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    const versions = {
      ...manifest['dependencies'],
      ...manifest['devDependencies'],
    };
    for (const [name, version] of Object.entries(versions)) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
