import { expect, it } from 'vitest'
import type { FleetNativeTarget } from '../src/app/fleet.ts'
import {
  deploymentEvent,
  deploymentSession,
  deploymentWorkspace,
  nativeEventId,
  nativeSessionId,
  nativeWorkspaceId,
  peerRequestValue,
  peerResponseValue,
  peerSessionControlValue,
  peerSessionFollowValue,
  peerSessionProjectionsValue,
  peerSessionListValue,
  mergeSessionSearches,
  repositoryTitle,
  requestDeployments,
  requestOwner,
} from '../src/app/native-aggregate.ts'

const target = (id: string, repository = `onenexus-team/${id}`): FleetNativeTarget => ({
  id,
  remote: false,
  repository,
  url: 'http://127.0.0.1:1234',
  nativeUrl: 'http://127.0.0.1:1234',
  profile: `superagent-${id}`,
  stateDir: `/tmp/${id}`,
  workspace: `/tmp/${id}/work`,
  token: 'x',
})

it('round-trips Session, Workspace, and Remote-event identities', () => {
  expect(deploymentSession(nativeSessionId('sglang', 'session/a+b'))).toEqual({ deployment: 'sglang', id: 'session/a+b' })
  expect(deploymentWorkspace(nativeWorkspaceId('loop', 'workspace'))).toEqual({ deployment: 'loop', id: 'workspace' })
  expect(deploymentEvent(nativeEventId('loop', 'event'))).toEqual({ deployment: 'loop', id: 'event' })
  expect(deploymentSession('dsh-superagent.session.not-base64!.id')).toBeUndefined()
  expect(deploymentWorkspace(nativeSessionId('loop', 'wrong-kind'))).toBeUndefined()
})

it('rewrites aggregate identities throughout an outbound request tree', () => {
  const value = {
    [nativeWorkspaceId('loop', 'workspace')]: {
      sessionId: nativeSessionId('loop', 'session'),
      nested: [nativeEventId('loop', 'event')],
    },
  }
  expect(peerRequestValue(value)).toEqual({
    workspace: {
      sessionId: 'session',
      nested: ['event'],
    },
  })
})

it('finds one owner but refuses mixed or unknown owners', () => {
  const loop = target('loop')
  const sglang = target('sglang')
  expect(requestOwner({
    sessionId: nativeSessionId('sglang', 'one'),
    parentSessionId: nativeSessionId('sglang', 'two'),
  }, [loop, sglang], loop)).toBe(sglang)
  expect(requestDeployments({
    workspaceId: nativeWorkspaceId('loop', 'workspace'),
    sessionId: nativeSessionId('sglang', 'session'),
  })).toEqual(['loop', 'sglang'])
  expect(() => requestOwner({
    workspaceId: nativeWorkspaceId('loop', 'workspace'),
    sessionId: nativeSessionId('sglang', 'session'),
  }, [loop, sglang], loop)).toThrow('Request spans multiple deployments')
  expect(() => requestOwner({ sessionId: nativeSessionId('missing', 'session') }, [loop, sglang], loop))
    .toThrow('Request names an unknown deployment')
})

it('remaps nested Session-list and Workspace data without touching unrelated strings', () => {
  const value = peerResponseValue({
    sessionId: 'session',
    parentSessionId: 'parent',
    workspaceId: 'workspace',
    sessionIds: ['child-1', 'child-2'],
    pinnedSessionIds: ['pinned'],
    jobs: { session: { jobId: 'job' } },
    subagentCatalog: [{ id: 'child', status: 'idle' }],
    path: 'session',
  }, 'loop')
  expect(value).toEqual({
    sessionId: nativeSessionId('loop', 'session'),
    parentSessionId: nativeSessionId('loop', 'parent'),
    workspaceId: nativeWorkspaceId('loop', 'workspace'),
    sessionIds: [nativeSessionId('loop', 'child-1'), nativeSessionId('loop', 'child-2')],
    pinnedSessionIds: [nativeSessionId('loop', 'pinned')],
    jobs: { [nativeSessionId('loop', 'session')]: { jobId: 'job' } },
    subagentCatalog: [{ id: nativeSessionId('loop', 'child'), status: 'idle' }],
    path: 'session',
  })
})

it('remaps Session follow headers and attributes title projections to the repository', () => {
  const loop = target('loop', 'onenexus-team/inference-support-loop')
  expect(peerSessionFollowValue({
    type: 'snapshot',
    header: {
      id: 'session',
      parentSession: 'parent',
      version: 1,
      createdAt: 1,
      isSeeded: false,
    },
    cursor: 1,
    records: [],
    hasMore: false,
    projections: {
      asOfSeq: 1,
      values: {
        title: 'Review',
        subagentCatalog: [{ id: 'child' }],
      },
    },
  }, loop)).toMatchObject({
    header: {
      id: nativeSessionId('loop', 'session'),
      parentSession: nativeSessionId('loop', 'parent'),
    },
    projections: {
      values: {
        title: 'onenexus-team/inference-support-loop · Review',
        subagentCatalog: [{ id: nativeSessionId('loop', 'child') }],
      },
    },
  })
})

it('keeps each Session-list row projection block and attributes its title', () => {
  const loop = target('loop')
  expect(peerSessionListValue({
    items: [
      { sessionId: 'session', projections: { kind: 'cached', asOfSeq: 4, values: { title: 'Review', subagentCatalog: [{ id: 'child' }] } } },
      { sessionId: 'blank' },
    ],
  }, loop)).toEqual({
    items: [
      {
        sessionId: nativeSessionId('loop', 'session'),
        projections: {
          kind: 'cached',
          asOfSeq: 4,
          values: { title: 'onenexus-team/loop · Review', subagentCatalog: [{ id: nativeSessionId('loop', 'child') }] },
        },
      },
      { sessionId: nativeSessionId('loop', 'blank') },
    ],
  })
})

it('remaps control baselines and projection titles', () => {
  const loop = target('loop')
  expect(peerSessionControlValue({
    type: 'baseline',
    value: {
      projections: {
        session: { asOfSeq: 2, values: { title: 'Review', subagentCatalog: [{ id: 'child' }] } },
      },
    },
  }, loop)).toMatchObject({
    value: {
      projections: {
        [nativeSessionId('loop', 'session')]: {
          values: {
            title: 'onenexus-team/loop · Review',
            subagentCatalog: [{ id: nativeSessionId('loop', 'child') }],
          },
        },
      },
    },
  })
  expect(peerSessionControlValue({
    type: 'projection',
    sessionId: 'session',
    key: 'title',
    value: 'Later',
    seq: 3,
  }, loop)).toEqual({
    type: 'projection',
    sessionId: nativeSessionId('loop', 'session'),
    key: 'title',
    value: 'onenexus-team/loop · Later',
    seq: 3,
  })
  expect(peerSessionProjectionsValue({
    kind: 'sequenced',
    asOfSeq: 1,
    values: { title: 'Read' },
  }, loop)).toMatchObject({
    values: { title: 'onenexus-team/loop · Read' },
  })
  expect(repositoryTitle('onenexus-team/loop', 'onenexus-team/loop · Already')).toBe('onenexus-team/loop · Already')
})

it('merges bounded Session searches without hiding a peer that has more results', () => {
  expect(mergeSessionSearches([
    { items: ['a', 'b'], hasMore: false },
    { items: ['c', 'd'], hasMore: true },
  ], 3)).toEqual({ items: ['a', 'b', 'c'], hasMore: true })
  expect(mergeSessionSearches([
    { items: ['a'], hasMore: false },
    { items: ['b'], hasMore: false },
  ], 2)).toEqual({ items: ['a', 'b'], hasMore: false })
})
