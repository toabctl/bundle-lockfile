import ext from 'bl-canary-ext';
import bundled from 'bl-canary-bundled';
export const dynamic = 'force-dynamic';
export async function GET() { return new Response(`${ext.marker} ${bundled.marker}`); }
