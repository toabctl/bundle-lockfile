'use client';
// A client component: ms in the client output (and the server's, which renders it too)
import ms from 'ms';
import { useState } from 'react';

export default function Clock() {
  const [n] = useState(1);
  return <p>{ms(n * 1000)}</p>;
}
