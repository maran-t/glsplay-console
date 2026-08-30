import { NextResponse } from 'next/server';

/**
 * Serves the browser its session config at request time.
 *
 * The alternative - `NEXT_PUBLIC_*` inlined by `next build` - forces a rebuild
 * of the bundle every time the room, secret or broker address changes, which
 * makes a VM image un-reusable: the whole point of baking one is that the same
 * disk boots for any session. Here the values arrive from GCE instance
 * metadata at boot (vm-scripts/boot.ps1 writes them into apps/web/.env, which
 * `next start` reads), and this route hands them out per request.
 *
 * Phase 2 replaces the shared room secret with a short-lived per-session token
 * minted by the control plane after the user authenticates. Until then this is
 * exactly as exposed as the inlined build-time value it replaces - no better,
 * no worse - so keep the VM firewalled to the players who should reach it.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  const signalingUrl =
    process.env['GLSPLAY_SIGNALING_URL'] ?? process.env['NEXT_PUBLIC_SIGNALING_URL'];
  const roomId = process.env['GLSPLAY_ROOM_ID'] ?? process.env['NEXT_PUBLIC_ROOM_ID'];
  const secret = process.env['GLSPLAY_ROOM_SECRET'] ?? process.env['NEXT_PUBLIC_ROOM_SECRET'];

  if (!signalingUrl || !roomId || !secret) {
    return NextResponse.json(
      {
        error: 'not-configured',
        missing: [
          signalingUrl ? null : 'GLSPLAY_SIGNALING_URL',
          roomId ? null : 'GLSPLAY_ROOM_ID',
          secret ? null : 'GLSPLAY_ROOM_SECRET',
        ].filter(Boolean),
      },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }

  return NextResponse.json(
    { signalingUrl, roomId, secret },
    { headers: { 'cache-control': 'no-store' } },
  );
}
