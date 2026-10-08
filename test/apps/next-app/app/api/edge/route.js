// A route handler on the edge runtime: built by the edge-server compiler, with nanoid
import { nanoid } from 'nanoid';

export const runtime = 'edge';
export function GET() {
  return new Response(nanoid());
}
