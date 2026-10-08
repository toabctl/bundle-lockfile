// A server component: lodash-es in the server output only (App Router); the client component brings ms to the client
import { chunk } from 'lodash-es';
import { v4 } from 'uuid';          // imported but UNUSED -> must not be listed
import Clock from './clock';

export default function Page() {
  return <div>{chunk([1, 2, 3, 4], 2).length}<Clock /></div>;
}
