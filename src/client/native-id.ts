/** Deployment-scoped native ids shared with the controller's aggregate Sidebar. */

function base64url(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Encode one deployment-local Session id for `uiWorkspace.openSession`.
 * @param deployment - Stable deployment id.
 * @param sessionId - Session id in that deployment's DSH profile.
 * @returns Aggregate Session id.
 */
export function nativeSessionId(deployment: string, sessionId: string): string {
  return `dsh-superagent.session.${base64url(deployment)}.${base64url(sessionId)}`
}
