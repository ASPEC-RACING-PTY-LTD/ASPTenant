/** @vitest-environment happy-dom */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Can, PermissionProvider, useCan, usePermissions } from '../src/adapters/react.js';
import type { PermissionSnapshot } from '../src/snapshot.js';

const snapshot: PermissionSnapshot = {
  version: 1,
  subjectId: 'u1',
  scope: {},
  generatedAt: Date.now(),
  roles: ['viewer'],
  permissions: ['posts:read'],
  denies: [],
  ownership: [],
  grants: [],
  decisions: { 'posts:read': true, 'posts:write': false },
  resourceDecisions: [],
};

function Probe() {
  const canRead = useCan('posts:read');
  const canWrite = useCan('posts:write');
  const perms = usePermissions();
  return (
    <div>
      <span data-testid="read">{String(canRead)}</span>
      <span data-testid="write">{String(canWrite)}</span>
      <span data-testid="roles">{perms.roles.join(',')}</span>
    </div>
  );
}

describe('React adapter', () => {
  it('renders Can and hooks from a snapshot', () => {
    render(
      <PermissionProvider snapshot={snapshot}>
        <Can permission="posts:read">
          <span>visible</span>
        </Can>
        <Can permission="posts:write" fallback={<span>hidden</span>}>
          <span>secret</span>
        </Can>
        <Probe />
      </PermissionProvider>,
    );
    expect(screen.getByText('visible')).toBeTruthy();
    expect(screen.getByText('hidden')).toBeTruthy();
    expect(screen.getByTestId('read').textContent).toBe('true');
    expect(screen.getByTestId('write').textContent).toBe('false');
    expect(screen.getByTestId('roles').textContent).toBe('viewer');
  });
});
