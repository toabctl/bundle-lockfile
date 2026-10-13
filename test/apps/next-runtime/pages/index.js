export async function getServerSideProps() {
  const rt = require('bl-canary-rt');
  const legacy = require('bl-canary-legacy/lib/x.cjs');
  return { props: { text: `${rt.marker} ${legacy.marker}` } };
}
export default function Home({ text }) { return <p>{text}</p>; }
