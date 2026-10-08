// Middleware runs on the edge runtime (edge-server compiler): is-number only here
import isNumber from 'is-number';
import { NextResponse } from 'next/server';

export function middleware(request) {
  return isNumber(request.nextUrl.searchParams.get('n')) ? NextResponse.next() : NextResponse.next();
}
export const config = { matcher: '/api/:path*' };
