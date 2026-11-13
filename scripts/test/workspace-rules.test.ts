import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
  // Every manifest the workspace globs (apps/*, packages/*) take in, plus the root's.
  const manifests = [
    'package.json',
    ...['apps', 'packages'].flatMap((folder) =>
      readdirSync(new URL(`${folder}/`, root), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${folder}/${entry.name}/package.json`)
        .filter((path) => existsSync(new URL(path, root))),
    ),
  ];

  it('finds every package the workspace globs take in, so a new one is checked too', () => {
    expect(manifests).toEqual(
      expect.arrayContaining([
        'package.json',
        'apps/web/package.json',
        'apps/backend/package.json',
        'packages/contract/package.json',
      ]),
    );
    expect(workspace).toMatch(/^packages:\n {2}- apps\/\*\n {2}- packages\/\*\n/m);
  });

  it.each(manifests)('%s pins every dependency to an exact version or the workspace', (path) => {
    const manifest = JSON.parse(readFileSync(new URL(path, root), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    const versions = {
      ...manifest['dependencies'],
      ...manifest['devDependencies'],
    };
    for (const [name, version] of Object.entries(versions)) {
      // Our own packages come from the workspace, never from the registry.
      if (name.startsWith('@instante/')) {
        expect(version, name).toBe('workspace:*');
        continue;
      }
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe('the tracked files', () => {
  it('include no symbolic link, whose target could name a local path', () => {
    const entries = execFileSync('git', ['ls-files', '--stage'], {
      cwd: new URL('.', root),
      encoding: 'utf8',
    });
    const links = entries
      .split('\n')
      .filter((line) => line.startsWith('120000 '))
      .map((line) => line.split('\t')[1]);
    expect(links).toEqual([]);
  });
});
